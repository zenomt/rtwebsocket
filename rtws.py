# Copyright 2017 Michael Thornburgh
# 
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
# 
#     http://www.apache.org/licenses/LICENSE-2.0
# 
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


from collections import deque
import time
import traceback

MSG_PING = 0x01
MSG_PING_REPLY = 0x41
MSG_FLOW_OPEN = 0x10
MSG_FLOW_OPEN_RETURN = 0x30
MSG_DATA_LAST = 0x1d
MSG_DATA_MORE = 0x3d
MSG_DATA_ABANDON = 0x1a
MSG_FLOW_CLOSE = 0x1c
MSG_DATA_ACK = 0x5a
MSG_FLOW_CLOSE_ACK = 0x5c
MSG_FLOW_EXCEPTION = 0x5e

PRI_LOWEST  = 0
PRI_HIGHEST = 7

PRI_BACKGROUND     = 0
PRI_BULK           = 1
PRI_DATA           = 2
PRI_ROUTINE        = 3
PRI_PRIORITY       = 4
PRI_IMMEDIATE      = 5
PRI_FLASH          = 6
PRI_FLASH_OVERRIDE = 7

NUM_PRIORITIES = 8

inf = float('infinity')


class _RTTEntry:
	def __init__(self, timestamp, rtt):
		self.timestamp = timestamp
		self.rtt = rtt

class IWebSocketAdapter(object):
	def send(self, msg):
		pass

	def callLater(self, item):
		pass

	def close(self):
		pass


class RTWebSocket(object):
	chunkSize  = 1400
	ackThresh  = 1400*2
	sendThresh = 1400*32
	defaultRcvbuf = 2097151
	rttHistoryThresh = 60
	rttHistoryCapacity = 5
	minOutstandingThresh = 16*1024
	outstandingThresh = 32*1024
	maxAdditionalDelay = 0.020

	sendFlowIDBatchSize = 16
	sendFlowIDRefresh   = 4

	def __init__(self, adapter):
		self._adapter = adapter
		self._isPaused = False
		self._sendFlowsByID = {}
		self._sendFlowFreeIDs = deque()
		self._recvFlowsByID = {}
		self._ackFlows = set()
		self._ackNow = False
		self._sendNow = False
		self._recvAccumulator = 0
		self._nextSendFlowID = 0
		self._isOpen = True
		self._sentBytesAccumulator = 0
		self._flowBytesSent = 0
		self._flowBytesAcked = 0
		self._rttAnchor = None
		self._rttPosition = 0
		self._rttPreviousPosition = 0
		self._rttMeasurements = deque([_RTTEntry(-inf, inf)])
		self._baseRTTCache = 0.1
		self._smoothedRTT = 0.1

		self._transmissionWork = {}
		for x in xrange(0, NUM_PRIORITIES):
			self._transmissionWork[x] = deque()

	def openFlow(self, metadata, pri = PRI_ROUTINE):
		return self._basicOpenFlow(metadata, pri, None)

	def close(self):
		if not self._isOpen:
			return

		self._isOpen = False
		self._adapter.close()

		self._callLater(self.onclose, self)

		for sendFlow in self._sendFlowsByID.values():
			if sendFlow.isOpen:
				sendFlow._onExceptionMessage(None, None)

		for recvFlow in self._recvFlowsByID.values():
			recvFlow._onFlowCloseMessage()

		# break reference cycles
		self._sendFlowsByID = {}
		self._recvFlowsByID = {}
		self._ackFlows = set()
		self._transmissionWork = {}

	@property
	def isOpen(self):
		return self._isOpen

	@property
	def bytesInflight(self):
		return self._flowBytesSent - self._flowBytesAcked

	@property
	def baseRTT(self):
		return self._baseRTTCache

	@property
	def rtt(self):
		return self._smoothedRTT

	def onrecvflow(self, recvFlow):
		print "onrecvflow", recvFlow

	def onclose(self, sender):
		print "onclose", sender

	# adapter interface

	def adapter_onReceive(self, message):
		if len(message) < 1:
			return

		message = bytearray(message)
		code = message[0]

		try:
			if code in [MSG_DATA_LAST, MSG_DATA_MORE]:
				self._onDataMessage(message)
			elif MSG_DATA_ACK == code:
				self._onDataAckMessage(message)
			elif code in [MSG_FLOW_OPEN, MSG_FLOW_OPEN_RETURN]:
				self._onFlowOpenMessage(message)
			elif MSG_DATA_ABANDON == code:
				self._onDataAbandonMessage(message)
			elif MSG_FLOW_CLOSE == code:
				self._onFlowCloseMessage(message)
			elif MSG_FLOW_CLOSE_ACK == code:
				self._onFlowCloseAckMessage(message)
			elif MSG_FLOW_EXCEPTION == code:
				self._onFlowExceptionMessage(message)
			elif MSG_PING == code:
				self._onPingMessage(message)
			elif MSG_PING_REPLY == code:
				self._onPingReplyMessage(message)
		except Exception, e:
			print "RTWebSocket protocol error", e
			traceback.print_exc()
			self.close()

	def adapter_pauseProducing(self):
		self._isPaused = True

	def adapter_resumeProducing(self):
		self._isPaused = False
		self._callLater(self.adapter_doPeriodicWork)

	def adapter_stopProducing(self):
		self.close()

	def adapter_doCallLater(self, item):
		item()

	def adapter_doPeriodicWork(self):
		self._transmit()
		self._sendAcks()

	# private methods

	def _callLater(self, callable_f, *p, **kw):
		def _item():
			callable_f(*p, **kw)
		self._adapter.callLater(_item)

	def _basicOpenFlow(self, metadata, pri, returnFlowID):
		if not self.isOpen:
			raise IOError("not open")
		flowID = self._getNextFreeSendFlowID()
		flow = SendFlow(self, flowID, returnFlowID, metadata)
		self._sendFlowsByID[flowID] = flow
		flow.priority = pri
		return flow

	def _getNextFreeSendFlowID(self):
		if len(self._sendFlowFreeIDs) < self.sendFlowIDRefresh:
			for x in xrange(0, self.sendFlowIDBatchSize):
				self._sendFlowFreeIDs.append(self._nextSendFlowID)
				self._nextSendFlowID += 1
		return self._sendFlowFreeIDs.popleft()

	def _sendBytes(self, message):
		if self._isOpen:
			if type(message) == list:
				message = bytearray(message)
			if type(message) == bytearray:
				message = bytes(message)
			self._adapter.send(message)
			self._sentBytesAccumulator += len(message)

	def _queueTransmission(self, sendFlow):
		if not self._isOpen:
			return
		flows = self._transmissionWork[sendFlow.priority]
		if sendFlow not in flows:
			flows.append(sendFlow)
		self._scheduleTransmission()

	def _scheduleTransmission(self):
		if self._sendNow:
			return
		self._callLater(self._transmit)
		self._sendNow = True

	def _transmit(self):
		if not self._isOpen:
			return
		self._sendNow = False
		self._sentBytesAccumulator = 0
		pri = PRI_HIGHEST
		while pri >= PRI_LOWEST:
			flows = self._transmissionWork[pri]
			while len(flows) > 0:
				if self._isPaused or (not self._isOpen) \
				  or (self._sentBytesAccumulator >= self.sendThresh) \
				  or (self.bytesInflight >= self.outstandingThresh):
					pri = -inf
					break
				sendFlow = flows.popleft()
				if sendFlow._transmit(pri):
					flows.append(sendFlow)
			pri -= 1
		self._startRTT()

	def _startRTT(self):
		if (self._rttAnchor is None) and (self._flowBytesSent > self._rttPreviousPosition):
			self._rttAnchor = time.time()
			self._rttPosition = self._flowBytesSent

	def _measureRTT(self):
		if (self._rttAnchor is not None) and (self._flowBytesAcked >= self._rttPosition):
			now = time.time()
			rtt = max(now - self._rttAnchor, 0.0001)
			numBytes = self._flowBytesSent - self._rttPreviousPosition
			bandwidth = numBytes / rtt
			self._rttAnchor = None
			self._rttPreviousPosition = self._flowBytesSent
			self._smoothedRTT = ((self._smoothedRTT * 7.0) + rtt) / 8.0

			self._addRTT(now, rtt)

			if numBytes >= self.outstandingThresh - self.ackThresh:
				self.outstandingThresh = max(self.minOutstandingThresh,
					bandwidth * (self.baseRTT + self.maxAdditionalDelay))

	def _addRTT(self, now, rtt):
		entry = self._rttMeasurements[0]
		if now - entry.timestamp > self.rttHistoryThresh:
			self._rttMeasurements.appendleft(_RTTEntry(now, rtt))
			while True:
				lastEntry = self._rttMeasurements[-1]
				if now - lastEntry.timestamp > self.rttHistoryThresh * self.rttHistoryCapacity:
					self._rttMeasurements.pop()
				else:
					break
			self._baseRTTCache = reduce(lambda l, r: min(l, r.rtt), self._rttMeasurements, inf)
		else:
			if rtt < entry.rtt:
				entry.rtt = rtt
			if rtt < self._baseRTTCache:
				self._baseRTTCache = rtt
			

	def _queueAck(self, recvFlow, immediate = False):
		self._ackFlows.add(recvFlow)
		if immediate:
			self._scheduleAckNow()

	def _scheduleAckNow(self):
		if self._ackNow:
			return
		self._callLater(self._sendAcks)
		self._ackNow = True

	def _sendAcks(self):
		self._ackNow = False
		while len(self._ackFlows):
			self._ackFlows.pop()._sendAck()
		self._recvAccumulator = 0

	def _sendPing(self):
		self._sendBytes(chr(MSG_PING) + "ping!")

	# packet handlers

	def _onPingMessage(self, message):
		print "_onPingMessage"
		message[0] = MSG_PING_REPLY
		self._sendBytes(message)

	def _onPingReplyMessage(self, message):
		print "_onPingReply", message[1:]

	def _onFlowOpenMessage(self, message):
		hasReturnAssociation = (MSG_FLOW_OPEN_RETURN == message[0])
		returnAssociation = None

		cursor, flowID = parseVLU(message, 1)
		if hasReturnAssociation:
			cursor, returnAssociationID = parseVLU(message, cursor)
			returnAssociation = self._sendFlowsByID.get(returnAssociationID, None)
		metadata = message[cursor:].decode('utf-8').encode('utf-8')

		if self._recvFlowsByID.get(flowID, None) is not None:
			raise ValueError("RecvFlow open: flowID " + flowID + " already in use")

		recvFlow = RecvFlow(self, flowID, metadata, returnAssociation)
		self._recvFlowsByID[flowID] = recvFlow

		if hasReturnAssociation and (returnAssociation is None):
			recvFlow.close(0, "return association not found")
			return

		try:
			if hasReturnAssociation:
				returnAssociation.onrecvflow(recvFlow)
			else:
				self.onrecvflow(recvFlow)
		except Exception, e:
			print "exception while notifying new RecvFlow", e
			traceback.print_exc()

		if not recvFlow.isOpen:
			recvFlow.close(0, "not accepted")

		recvFlow._queueAck(True)

	def _onDataMessage(self, message):
		more = (MSG_DATA_MORE == message[0])

		cursor, flowID = parseVLU(message, 1)
		msgFragment = message[cursor:]

		recvFlow = self._recvFlowsByID[flowID]

		self._recvAccumulator += len(message)
		if self._recvAccumulator >= self.ackThresh:
			self._scheduleAckNow()

		recvFlow._onData(more, msgFragment, len(message))

	def _onDataAbandonMessage(self, message):
		cursor, flowID = parseVLU(message, 1)

		countMinusOne = 0
		if cursor < len(message):
			cursor, countMinusOne = parseVLU(message, cursor)

		self._recvFlowsByID[flowID]._onDataAbandon(countMinusOne)

	def _onFlowCloseMessage(self, message):
		cursor, flowID = parseVLU(message, 1)
		self._recvFlowsByID[flowID]._onFlowCloseMessage()
		del self._recvFlowsByID[flowID]

	def _onDataAckMessage(self, message):
		cursor, flowID = parseVLU(message, 1)
		cursor, position = parseVLU(message, cursor)
		cursor, bufferAdvertisement = parseVLU(message, cursor)

		self._sendFlowsByID[flowID]._onAck(position, bufferAdvertisement)

	def _onFlowCloseAckMessage(self, message):
		cursor, flowID = parseVLU(message, 1)
		sendFlow = self._sendFlowsByID[flowID]
		self._sendFlowFreeIDs.append(flowID)
		del self._sendFlowsByID[flowID]

	def _onFlowExceptionMessage(self, message):
		reasonCode = None
		description = None
		cursor, flowID = parseVLU(message, 1)
		if cursor < len(message):
			cursor, reasonCode = parseVLU(message, cursor)
			if cursor < len(message):
				description = message[cursor:].decode("utf-8")
		self._sendFlowsByID[flowID]._onExceptionMessage(reasonCode, description)


class SendFlow(object):
	def __repr__(self):
		return "<SendFlow id:" + `self._flowID` + " @" + hex(id(self)) + ">"

	def __init__(self, owner, flowID, returnFlowID, metadata):
		self._owner = owner
		self._flowID = flowID
		self._priority = PRI_ROUTINE
		self._sendBuffer = deque()
		self._sendBufferByteLength = 0
		self._sentByteCount = 0
		self._sendThroughAllowed = self._rcvbuf = 65536
		self._sndbuf = 65536
		self._open = True
		self._writablePending = False
		self._shouldNotifyWhenWritable = False
		self._ackedPosition = 0

		metadata = metadata or ""
		if type(metadata) == unicode:
			metadata = metadata.encode("utf-8")

		self._flowOpenMessage = bytearray().join([
			chr(MSG_FLOW_OPEN_RETURN) if returnFlowID >= 0 else chr(MSG_FLOW_OPEN),
			makeVLU(flowID),
			makeVLU(returnFlowID) if returnFlowID >= 0 else bytearray(),
			metadata
		])

		self._flowCloseMessage = bytearray().join([chr(MSG_FLOW_CLOSE), makeVLU(flowID)])

	def write(self, data, startBy = inf, endBy = inf):
		if type(data) != str:
			if type(data) == unicode:
				data = data.encode('utf-8')
			if type(data) == list:
				data = bytearray(data)
			if type(data) == bytearray:
				data = bytes(data)

		if not self._open:
			raise IOError("write: flow is closed")

		receipt = WriteReceipt(self._owner._callLater)
		receipt.startBy = startBy
		receipt.endBy = endBy

		message = self.WriteMessage(data, receipt)
		self._sendBuffer.append(message)
		self._sendBufferByteLength += len(data)

		self._queueTransmission()
		return receipt

	def close(self):
		if not self._open:
			return
		self._open = False
		self._queueTransmission()

	def abandonQueuedMessages(self, age = 0):
		for message in self._sendBuffer:
			if message.receipt.age >= age:
				message.receipt.abandon()
			else:
				break
		self._queueTransmission()

	@property
	def priority(self):
		return self._priority
	@priority.setter
	def priority(self, val):
		val = max(PRI_LOWEST, min(PRI_HIGHEST, int(val)))
		self._priority = val
		self._queueTransmission()

	@property
	def sndbuf(self):
		return self._sndbuf
	@sndbuf.setter
	def sndbuf(self, val):
		self._sndbuf = val
		self._queueWritableNotify()

	@property
	def bufferLength(self):
		return self._sendBufferByteLength

	@property
	def rcvbuf(self):
		return self._rcvbuf

	@property
	def writable(self):
		return self.isOpen and (self.bufferLength < self.sndbuf)

	@property
	def isOpen(self):
		return self._open

	@property
	def unsentAge(self):
		for message in self._sendBuffer:
			if not message.receipt.abandoned:
				return message.receipt.age
		return 0

	def notifyWhenWritable(self):
		self._shouldNotifyWhenWritable = True
		self._queueWritableNotify()

	def onwritable(self, sendFlow):
		return False

	def onexception(self, sendFlow, code, description):
		print "onexception", code, description

	def onrecvflow(self, recvFlow):
		print "onrecvflow", recvFlow

	def _queueWritableNotify(self):
		if self._shouldNotifyWhenWritable and not self._writablePending:
			self._owner._callLater(self._doWritable)
			self._writablePending = True

	def _queueTransmission(self):
		self._owner._queueTransmission(self)

	def _doWritable(self):
		self._writablePending = False
		while self._shouldNotifyWhenWritable and self.writable:
			self._shouldNotifyWhenWritable = False
			try:
				self._shouldNotifyWhenWritable = bool(self.onwritable(self))
			except Exception, e:
				traceback.print_exc()
				print "exception calling SendFlow.onwritable", e

	def _transmit(self, priority):
		if priority != self.priority:
			return False

		if self._flowOpenMessage is not None:
			self._owner._sendBytes(self._flowOpenMessage)
			self._flowOpenMessage = None
			return True

		abandonCount = self._trimSendBuffer()
		if abandonCount:
			abandonMessage = bytearray().join([
				chr(MSG_DATA_ABANDON),
				makeVLU(self._flowID),
				makeVLU(abandonCount - 1) if abandonCount > 1 else b''
			])
			self._owner._sendBytes(abandonMessage)
			self._queueWritableNotify()
			return True

		if (0 == len(self._sendBuffer)) and (not self._open) and (self._flowCloseMessage is not None):
			self._owner._sendBytes(self._flowCloseMessage)
			self._flowCloseMessage = None
			return True

		if self._sentByteCount >= self._sendThroughAllowed:
			return False

		return self._transmitOneFragment()

	def _trimSendBuffer(self):
		abandonCount = 0
		while len(self._sendBuffer):
			message = self._sendBuffer[0]
			if message.receipt.abandoned:
				message.receipt.abandon()
				abandonCount += 1
				self._sendBufferByteLength -= len(message.data)
				self._sendBuffer.popleft()
			else:
				break
		return abandonCount

	def _transmitOneFragment(self):
		message = self._sendBuffer[0] if len(self._sendBuffer) else None
		if (message is None) or message.receipt.abandoned:
			return False

		chunkSize = max(0, min(self._owner.chunkSize, self._sendThroughAllowed - self._sentByteCount))
		if 0 == chunkSize:
			return False

		offsetFrom = message.offset
		offsetTo = min(offsetFrom + chunkSize, len(message.data))
		fragment = message.data[offsetFrom:offsetTo]
		isLast = (offsetTo == len(message.data))
		
		fragmentMessage = bytearray().join([
			chr(MSG_DATA_LAST if isLast else MSG_DATA_MORE),
			makeVLU(self._flowID),
			fragment
		])

		self._owner._sendBytes(fragmentMessage)
		self._sentByteCount += len(fragmentMessage)
		self._owner._flowBytesSent += len(fragmentMessage)
		message.offset = offsetTo
		message.receipt._onStarted()

		if isLast:
			message.receipt._onSent()
			self._sendBuffer.popleft()
			self._sendBufferByteLength -= len(message.data)
			self._queueWritableNotify()

		return True

	def _onAck(self, position, bufferAdvertisement):
		self._owner._flowBytesAcked += max(0, position - self._ackedPosition)
		self._ackedPosition = max(self._ackedPosition, position)
		self._rcvbuf = bufferAdvertisement
		self._sendThroughAllowed = position + bufferAdvertisement
		self._owner._measureRTT()
		self._queueTransmission()
		self._queueWritableNotify()

	def _onExceptionMessage(self, code, description):
		self.close()
		self.abandonQueuedMessages(-inf)
		try:
			self.onexception(self, code, description)
		except Exception, e:
			print "error sending SendFlow.onexception", e
			traceback.print_exc()
		self._queueTransmission()

	class WriteMessage(object):
		def __init__(self, data, receipt):
			self.data = data
			self.receipt = receipt
			self.offset = 0


class RecvFlow(object):
	def __repr__(self):
		return "<RecvFlow id:" + `self._flowID` + " @" + hex(id(self)) + ' "' + self.metadata + '">'

	def __init__(self, owner, flowID, metadata, returnAssociation):
		self._owner = owner
		self._flowID = flowID
		self._metadata = metadata
		self._associatedSendFlow = returnAssociation
		self._userOpen = False
		self._open = True
		self._paused = False
		self._receiveBuffer = deque()
		self._receiveBufferByteLength = 0
		self._receivedByteCount = 0
		self._complete = False
		self._sentComplete = False
		self._sentCloseAck = False
		self._nextMessageNumber = 1
		self._deliveryPending = False
		self._mode = "binary"
		self._rcvbuf = owner.defaultRcvbuf

	def accept(self):
		if self._open:
			self._userOpen = True

	def openReturnFlow(self, metadata, pri = PRI_ROUTINE):
		if (not self.isOpen) or self._complete:
			return
		return self._owner._basicOpenFlow(metadata, pri, self._flowID)

	def close(self, code = None, description = None):
		if not self._open:
			return

		self._userOpen = False
		self._open = False
		self.rcvbuf = 0

		if self._complete:
			return

		message = chr(MSG_FLOW_EXCEPTION) + makeVLU(self._flowID)
		if code >= 0:
			message += makeVLU(code)
			if type(description) == str:
				message += description
			elif type(description) == unicode:
				message += description.encode('utf-8')
		self._owner._sendBytes(message)

	@property
	def metadata(self):
		return self._metadata

	@property
	def isOpen(self):
		return self._open and self._userOpen

	@property
	def rcvbuf(self):
		return self._rcvbuf
	@rcvbuf.setter
	def rcvbuf(self, val):
		if val != self._rcvbuf:
			self._queueAck(True)
		self._rcvbuf = max(0, val)

	@property
	def advertisement(self):
		return max(0, self.rcvbuf - self.bufferLength) if self._paused else self.rcvbuf

	@property
	def bufferLength(self):
		return self._receiveBufferByteLength

	@property
	def paused(self):
		return self._paused
	@paused.setter
	def paused(self, val):
		wasPaused = self._paused
		self._paused = bool(val)
		if not self._paused:
			self._queueDelivery
			if wasPaused:
				self._queueAck(True)

	@property
	def associatedSendFlow(self):
		return self._associatedSendFlow

	@property
	def mode(self):
		return self._mode
	@mode.setter
	def mode(self, val):
		self._mode = val if val in ["binary", "text", "unicode"] else "binary"

	def onmessage(self, recvFlow, message, number):
		print "onmessage", recvFlow, "#", number

	def oncomplete(self, recvFlow):
		print "oncomplete", recvFlow

	def _queueAck(self, immediate = False):
		self._owner._queueAck(self, immediate)

	def _sendAck(self):
		if self._sentCloseAck:
			return

		message = chr(MSG_DATA_ACK) + makeVLU(self._flowID) + \
			makeVLU(self._receivedByteCount) + makeVLU(self.advertisement)
		self._owner._sendBytes(message)

		if self._complete:
			self._owner._sendBytes(chr(MSG_FLOW_CLOSE_ACK) + makeVLU(self._flowID))
			self._sentCloseAck = True

	def _onFlowCloseMessage(self):
		self._complete = True
		self._onDataAbandon(0)
		self._queueDelivery()
		self._sendAck()

	def _onData(self, more, msgFragment, chunkLength):
		self._receivedByteCount += chunkLength
		self._receiveBufferByteLength += len(msgFragment)

		message = self._receiveBuffer[-1] if len(self._receiveBuffer) else None
		if (message is None) or (message.complete):
			message = self.ReadMessage(self._nextMessageNumber)
			self._nextMessageNumber += 1
			self._receiveBuffer.append(message)

		message.addFragment(more, msgFragment)
		if message.complete:
			self._queueDelivery()

		self._queueAck()

	def _onDataAbandon(self, countMinusOne):
		count = countMinusOne + 1
		message = self._receiveBuffer[-1] if len(self._receiveBuffer) else None
		if message and not message.complete:
			self._receiveBuffer.pop()
			self._receiveBufferByteLength -= message.totalLength
			count -= 1
		self._nextMessageNumber += count
		self._queueAck(True)

	def _queueDelivery(self):
		if (not self._deliveryPending) and (not self.paused):
			self._owner._callLater(self._deliverData)
			self._deliveryPending = True

	def _deliverData(self):
		self._deliveryPending = False
		while len(self._receiveBuffer):
			if self.paused or not self.isOpen:
				break
			message = self._receiveBuffer[0]
			if not message.complete:
				break

			self._receiveBuffer.popleft()
			self._receiveBufferByteLength -= message.totalLength

			fullMessage = message.getFullMessage()
			if "binary" != self._mode:
				fullMessage = fullMessage.decode("utf-8")
			if "text" == self._mode:
				fullMessage = fullMessage.encode("utf-8")

			try:
				self.onmessage(self, fullMessage, message.messageNumber)
			except Exception, e:
				print "exception calling RecvFlow.onmessage", e
				traceback.print_exc()

		if self._complete:
			if not self._sentComplete:
				self._sentComplete = True
				try:
					if self.isOpen:
						self.oncomplete(self)
				except Exception, e:
					print "exception calling RecvFlow.oncomplete", e
					traceback.print_exc()
				self.close()

	class ReadMessage(object):
		def __init__(self, messageNumber):
			self.messageNumber = messageNumber
			self.fragments = []
			self.totalLength = 0
			self.complete = False

		def addFragment(self, more, fragmentBytes):
			self.fragments.append(fragmentBytes)
			self.totalLength += len(fragmentBytes)
			if not more:
				self.complete = True

		def getFullMessage(self):
			if 1 == len(self.fragments):
				return self.fragments[0]
			return bytearray().join(self.fragments)


class WriteReceipt(object):
	def __init__(self, callLater_f):
		self._origin = time.time()
		self._abandoned = False
		self._sent = False
		self._started = False
		self._startBy = inf
		self._endBy = inf
		self._callLater_f = callLater_f

	def abandon(self):
		if not self._abandoned:
			self._abandoned = True
			if not self._sent:
				self._callLater_f(self.onabandoned, self)

	@property
	def startBy(self):
		return self._startBy
	@startBy.setter
	def startBy(self, val):
		self._startBy = 0.0 + val

	@property
	def endBy(self):
		return self._endBy
	@endBy.setter
	def endBy(self, val):
		self._endBy = 0.0 + val

	@property
	def abandoned(self):
		if self._abandoned:
			return True
		if self._sent:
			return False
		age = self.age
		if (self._started) and (age > self._endBy):
			return True
		if (not self._started) and (age > self._startBy):
			return True
		return False

	@property
	def sent(self):
		return self._sent

	@property
	def started(self):
		return self._started

	@property
	def age(self):
		return time.time() - self._origin

	def onsent(self, receipt):
		pass

	def onabandoned(self, receipt):
		pass

	def _onStarted(self):
		self._started = True

	def _onSent(self):
		self._sent = True
		self._callLater_f(self.onsent, self)


def makeVLU(n):
        b = bytearray()
        more = False
        while True:
                digit = n & 0x7f
                if more:
                        digit |= 128
                b.append(digit)
                if n < 128:
                        break
                n = n >> 7
                more = True
        b.reverse()
        return bytes(b)

def parseVLU(bytestring, cursor=0, limit=-1):
        bytestring = bytes(bytestring or '')
        if limit < 0 or limit > len(bytestring):
                limit = len(bytestring)
        rv = 0
        while cursor < limit:
                each = ord(bytestring[cursor])
                rv += each & 0x7f
                cursor += 1
                if 0 == each & 0x80:
                        return (cursor, rv)
                rv = rv << 7
        raise IndexError("incomplete VLU")
