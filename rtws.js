// Copyright © 2017 Michael Thornburgh
// SPDX-License-Identifier: MIT

function RTWebSocket(url) {
	this._url = url;
	this._ws = new WebSocket(url);
	this._ws.binaryType = "arraybuffer";
	this._ws.onmessage = this._onWSMessage.bind(this);
	this._ws.onopen = this._onWSOpen.bind(this);
	this._ws.onclose = this.close.bind(this);
	this._sendFlowsByID = {};
	this._sendFlowFreeIDs = [];
	this._recvFlowsByID = {};
	this._ackFlows = [];
	this._ackNow = false;
	this._sendNow = false;
	this._recvAccumulator = 0;
	this._ackWindow = this.minAckWindow;
	this._nextSendFlowID = 0;
	this._delackInterval = setInterval(this._intervalWork.bind(this), 250);
	this._sentBytesAccumulator = 0;
	this._flowBytesSent = 0;
	this._flowBytesAcked = 0;
	this._rttAnchor = undefined;
	this._rttPosition = 0;
	this._rttPreviousPosition = 0;
	this._rttMeasurements = [{time:-Infinity, rtt: Infinity}];
	this._baseRTTCache = 0.1;
	this._smoothedRTT = 0.1;

	this._transmissionWork = [];
	for(var x = this.PRI_LOWEST; x <= this.PRI_HIGHEST; x++)
		this._transmissionWork.push([]);

	this._userOpen = true;
	this._isOpen = false;
}

RTWebSocket.prototype.chunkSize  = 1400;
RTWebSocket.prototype.minAckWindow  = 1400*2;
RTWebSocket.prototype.maxAckWindow = 1400*8;
RTWebSocket.prototype.rttHistoryThresh = 60;
RTWebSocket.prototype.rttHistoryCapacity = 5;
RTWebSocket.prototype.minOutstandingThresh = 1024*64;
RTWebSocket.prototype.outstandingThresh = 1024*64;
RTWebSocket.prototype.maxAdditionalDelay = 0.050;
RTWebSocket.prototype.sendFlowIDBatchSize = 16;
RTWebSocket.prototype.sendFlowIDRefresh = 4;

RTWebSocket.prototype.PRI_LOWEST  = 0;
RTWebSocket.prototype.PRI_HIGHEST = 7;

RTWebSocket.prototype.PRI_BACKGROUND     = 0;
RTWebSocket.prototype.PRI_BULK           = 1;
RTWebSocket.prototype.PRI_DATA           = 2;
RTWebSocket.prototype.PRI_ROUTINE        = 3;
RTWebSocket.prototype.PRI_PRIORITY       = 4;
RTWebSocket.prototype.PRI_IMMEDIATE      = 5;
RTWebSocket.prototype.PRI_FLASH          = 6;
RTWebSocket.prototype.PRI_FLASH_OVERRIDE = 7;

RTWebSocket.prototype.openFlow = function(metadata, pri) {
	return this._basicOpenFlow(metadata, pri);
}

RTWebSocket.prototype.close = function() {
	if(!this._userOpen)
		return;

	this._userOpen = false;
	this._isOpen = false;

	this._ws.close();

	var self = this;
	if(this.onclose)
		Promise.resolve().then(function() { self.onclose(self); });

	var keys = Object.keys(this._sendFlowsByID);
	var x;
	for(x = 0; x < keys.length; x++)
	{
		var sendFlow = this._sendFlowsByID[keys[x]];
		if(sendFlow && sendFlow.isOpen)
			sendFlow._onExceptionMessage();
	}

	keys = Object.keys(this._recvFlowsByID);
	for(x = 0; x < keys.length; x++)
	{
		var recvFlow = this._recvFlowsByID[keys[x]];
		if(recvFlow)
			recvFlow._onFlowCloseMessage();
	}

	// unlink to help GC
	this._sendFlowsByID = {};
	this._recvFlowsByID = {};
	this._ackFlows = [];
	clearInterval(this._delackInterval);
}

RTWebSocket.prototype.onrecvflow = function(recvFlow) { console.log("RTWebSocket onrecvflow", recvFlow); }

RTWebSocket.prototype.onopen = function(sender) { console.log("RTWebSocket onopen", sender); }
RTWebSocket.prototype.onclose = function(sender) { console.log("RTWebSocket onclose", sender); }

RTWebSocket.MSG_PING              = 0x01;
RTWebSocket.MSG_PING_REPLY        = 0x41;
RTWebSocket.MSG_ACK_WINDOW        = 0x0a;
RTWebSocket.MSG_FLOW_OPEN         = 0x10;
RTWebSocket.MSG_FLOW_OPEN_RETURN  = 0x30;
RTWebSocket.MSG_DATA_LAST         = 0x1d;
RTWebSocket.MSG_DATA_MORE         = 0x3d;
RTWebSocket.MSG_DATA_ABANDON      = 0x1a;
RTWebSocket.MSG_FLOW_CLOSE        = 0x1c;
RTWebSocket.MSG_DATA_ACK          = 0x5a;
RTWebSocket.MSG_FLOW_CLOSE_ACK    = 0x5c;
RTWebSocket.MSG_FLOW_EXCEPTION    = 0x5e;

Object.defineProperties(RTWebSocket.prototype, {
	isOpen: { get: function() { return this._isOpen; }, enumerable: true },
	bytesInflight: { get: function() { return this._flowBytesSent - this._flowBytesAcked; }, enumerable: true },
	baseRTT: { get: function() { return this._baseRTTCache; }, enumerable: true },
	rtt: { get: function() { return this._smoothedRTT; }, enumerable: true },
});

if(window.performance)
	RTWebSocket._now = function() { return window.performance.now() / 1000.0; }
else
	RTWebSocket._now = function() { return (new Date()).getTime() / 1000.0; }
RTWebSocket.getCurrentTime = RTWebSocket._now;

RTWebSocket.prototype._basicOpenFlow = function(metadata, pri, returnFlowID) {
	if(!this.isOpen)
		throw new Error("not open");

	var flowID = this._getNextFreeSendFlowID();
	var flow = new this._SendFlow(this, flowID, returnFlowID, metadata);
	this._sendFlowsByID[flowID] = flow;
	flow.priority = pri;
	return flow;
}

RTWebSocket.prototype._getNextFreeSendFlowID = function() {
	if(this._sendFlowFreeIDs.length < this.sendFlowIDRefresh)
	{
		for(var x = 0; x < this.sendFlowIDBatchSize; x++)
			this._sendFlowFreeIDs.push(this._nextSendFlowID++);
	}

	return this._sendFlowFreeIDs.shift();
}

RTWebSocket.prototype._sendPing = function() {
	this._sendBytes([RTWebSocket.MSG_PING]);
}

RTWebSocket.prototype._sendBytes = function(message) {
	if(message instanceof Array)
		message = new Uint8Array(message);
	if(this._ws.OPEN == this._ws.readyState)
		this._ws.send(message);
	this._sentBytesAccumulator += message.length;
}

RTWebSocket.prototype._onWSOpen = function(e) {
	this._isOpen = true;

	if(this.onopen)
		this.onopen(this);
}

RTWebSocket.prototype._onWSMessage = function(e) {
	var data = e.data;
	if(!(data instanceof ArrayBuffer))
		return;
	data = new Uint8Array(data);

	if(data.length < 1)
		return;

	try {
		switch(data[0])
		{
			case RTWebSocket.MSG_PING:
				this._onPingMessage(data);
				break;
	
			case RTWebSocket.MSG_PING_REPLY:
				this._onPingReplyMessage(data);
				break;

			case RTWebSocket.MSG_ACK_WINDOW:
				this._onAckWindowMessage(data);
				break;
	
			case RTWebSocket.MSG_FLOW_OPEN:
			case RTWebSocket.MSG_FLOW_OPEN_RETURN:
				this._onFlowOpenMessage(data);
				break;
	
			case RTWebSocket.MSG_DATA_LAST:
			case RTWebSocket.MSG_DATA_MORE:
				this._onDataMessage(data);
				break;
	
			case RTWebSocket.MSG_DATA_ABANDON:
				this._onDataAbandonMessage(data);
				break;
	
			case RTWebSocket.MSG_FLOW_CLOSE:
				this._onFlowCloseMessage(data);
				break;
	
			case RTWebSocket.MSG_DATA_ACK:
				this._onDataAckMessage(data);
				break;
	
			case RTWebSocket.MSG_FLOW_CLOSE_ACK:
				this._onFlowCloseAckMessage(data);
				break;
	
			case RTWebSocket.MSG_FLOW_EXCEPTION:
				this._onFlowExceptionMessage(data);
				break;
		}
	} catch(e) {
		console.log("RTWebSocket protocol error", e);
		this.close();
	}
}

RTWebSocket.prototype._onPingMessage = function(data) {
	console.log("onPingMessage", data);
	data[0] = RTWebSocket.MSG_PING_REPLY;
	this._ws.send(data);
}

RTWebSocket.prototype._onPingReplyMessage = function(data) {
	console.log("onPingReplyMessage", data);
}

RTWebSocket.prototype._onAckWindowMessage = function(data) {
	var ackWindow = {};
	var cursor = 1;

	cursor += this.parseVLU(data, cursor, -1, ackWindow);

	this._ackWindow = Math.max(ackWindow.value, this.minAckWindow);
	this._recvAccumulator = 0;
}

RTWebSocket.prototype._onFlowOpenMessage = function(data) {
	var cursor = 1;
	var flowID = {};
	var returnAssociationID = {};
	var hasReturnAssociation;
	var metadata;

	hasReturnAssociation = (RTWebSocket.MSG_FLOW_OPEN_RETURN == data[0]);

	cursor += this.parseVLU(data, cursor, -1, flowID);

	if(hasReturnAssociation)
		cursor += this.parseVLU(data, cursor, -1, returnAssociationID);

	metadata = data.subarray ? data.subarray(cursor) : data.slice(cursor);

	if(this._recvFlowsByID[flowID.value])
		throw new ReferenceError("RecvFlow open: flowID already in use");
	var returnFlowAssociation;
	if(hasReturnAssociation)
		returnFlowAssociation = this._sendFlowsByID[returnAssociationID.value];

	var recvFlow = new this._RecvFlow(this, flowID.value, metadata, returnFlowAssociation);
	this._recvFlowsByID[flowID.value] = recvFlow;

	if(hasReturnAssociation && ((!returnFlowAssociation) || (!returnFlowAssociation.isOpen)))
	{
		recvFlow.close(0, "return association not found");
		return;
	}

	try {
		if(hasReturnAssociation)
		{
			if(returnFlowAssociation.onrecvflow)
				returnFlowAssociation.onrecvflow(recvFlow);
		}
		else
		{
			if(this.onrecvflow)
				this.onrecvflow(recvFlow);
		}
	} catch(e) {
		console.log("exception while notifying new RecvFlow", e);
	}

	if(!recvFlow.isOpen)
		recvFlow.close(0, "not accepted");

	recvFlow._queueAck(true);
}

RTWebSocket.prototype._onDataMessage = function(data) {
	var cursor = 1;
	var flowID = {};
	var msgFragment;

	var more = (RTWebSocket.MSG_DATA_MORE == data[0]);
	cursor += this.parseVLU(data, cursor, -1, flowID);
	msgFragment = data.subarray ? data.subarray(cursor) : data.slice(cursor);

	var recvFlow = this._recvFlowsByID[flowID.value];
	if(!recvFlow)
		throw new ReferenceError("RecvFlow (" + flowID.value + ") not found for message fragment");

	this._recvAccumulator += data.length;
	if(this._recvAccumulator >= this._ackWindow)
	{
		this._scheduleAckNow();
		this._recvAccumulator = this._recvAccumulator % this._ackWindow;
	}

	recvFlow._onData(more, msgFragment, data.length);
}

RTWebSocket.prototype._onDataAbandonMessage = function(data) {
	var cursor = 1;
	var flowID = {};
	var countMinusOne = { value: 0 };

	cursor += this.parseVLU(data, cursor, -1, flowID);
	if(cursor < data.length)
		cursor += this.parseVLU(data, cursor, -1, countMinusOne);

	var recvFlow = this._recvFlowsByID[flowID.value];
	if(!recvFlow)
		throw new ReferenceError("RecvFlow (" + flowID.value + ") not found for abandon message");

	recvFlow._onDataAbandon(countMinusOne.value);
}

RTWebSocket.prototype._onFlowCloseMessage = function(data) {
	var cursor = 1;
	var flowID = {};

	cursor += this.parseVLU(data, cursor, -1, flowID);

	var recvFlow = this._recvFlowsByID[flowID.value];
	if(!recvFlow)
		throw new ReferenceError("RecvFlow (" + flowID.value + ") not found for flow close");

	recvFlow._onFlowCloseMessage();

	delete this._recvFlowsByID[flowID.value];
}

RTWebSocket.prototype._onDataAckMessage = function(data) {
	var cursor = 1;
	var flowID = {};
	var deltaBytes = {};
	var bufferAdvertisement = {};

	cursor += this.parseVLU(data, cursor, -1, flowID);
	cursor += this.parseVLU(data, cursor, -1, deltaBytes);
	cursor += this.parseVLU(data, cursor, -1, bufferAdvertisement);

	var sendFlow = this._sendFlowsByID[flowID.value];
	if(!sendFlow)
		throw new ReferenceError("SendFlow (" + flowID.value + ") not found for ack");

	sendFlow._onAck(deltaBytes.value, bufferAdvertisement.value);
}

RTWebSocket.prototype._onFlowCloseAckMessage = function(data) {
	var cursor = 1;
	var flowID = {};

	cursor += this.parseVLU(data, cursor, -1, flowID);

	var sendFlow = this._sendFlowsByID[flowID.value];
	if(!sendFlow)
		throw new ReferenceError("SendFlow (" + flowID.value + ") not found for close ack");

	this._sendFlowFreeIDs.push(flowID.value);
	delete this._sendFlowsByID[flowID.value];
}

RTWebSocket.prototype._onFlowExceptionMessage = function(data) {
	var cursor = 1;
	var limit = data.length;
	var flowID = {};
	var reasonCode = {};
	var description;

	cursor += this.parseVLU(data, cursor, limit, flowID);
	if(cursor < limit)
		cursor += this.parseVLU(data, cursor, limit, reasonCode);
	if(cursor < limit)
		description = this.UTF8.decode(data, cursor, limit);

	var sendFlow = this._sendFlowsByID[flowID.value];
	if(!sendFlow)
		throw new ReferenceError("SendFlow (" + flowID.value + ") not found for close ack");

	sendFlow._onExceptionMessage(reasonCode.value, description);
}

RTWebSocket.prototype._queueAck = function(recvFlow, immediate) {
	if(this._ackFlows.indexOf(recvFlow) < 0)
		this._ackFlows.push(recvFlow);
	if(immediate)
		this._scheduleAckNow();
}

RTWebSocket.prototype._scheduleAckNow = function() {
	if(this._ackNow)
		return;
	Promise.resolve().then(this._sendAcks.bind(this));
	this._ackNow = true;
}

RTWebSocket.prototype._sendAcks = function() {
	this._ackNow = false;
	var recvFlow;
	while((recvFlow = this._ackFlows.shift()))
		recvFlow._sendAck();
}

RTWebSocket.prototype._queueTransmission = function(sendFlow) {
	var workQueue = this._transmissionWork[sendFlow.priority];
	if(workQueue.indexOf(sendFlow) < 0)
		workQueue.push(sendFlow);
	this._scheduleTransmission();
}

RTWebSocket.prototype._scheduleTransmission = function() {
	if(this._sendNow)
		return;
	Promise.resolve().then(this._transmit.bind(this));
	this._sendNow = true;
}

RTWebSocket.prototype._transmit = function() {
	this._sendNow = false;
	this._sentBytesAccumulator = 0;
	for(var pri = this.PRI_HIGHEST; pri >= this.PRI_LOWEST; pri--)
	{
		var workQueue = this._transmissionWork[pri];
		while(workQueue.length > 0)
		{
			if(this.bytesInflight >= this.outstandingThresh)
			{
				pri = -Infinity;
				break;
			}

			var sendFlow = workQueue.shift();
			if(sendFlow._transmit(pri))
				workQueue.push(sendFlow);
		}
	}

	this._startRTT();
}

RTWebSocket.prototype._startRTT = function() {
	if((!this._rttAnchor) && (this._flowBytesSent >= this._rttPreviousPosition))
	{
		this._rttAnchor = RTWebSocket._now();
		this._rttPosition = this._flowBytesSent;

		var ackWin = Math.max(this.minAckWindow, (this._flowBytesSent - this._flowBytesAcked) / 4);
		ackWin = Math.min(ackWin, this.maxAckWindow);

		this._sendBytes([RTWebSocket.MSG_ACK_WINDOW].concat(this.makeVLU(ackWin)));
	}
}

RTWebSocket.prototype._measureRTT = function() {
	if(this._rttAnchor && (this._flowBytesAcked > this._rttPosition))
	{
		var rtt = Math.max(RTWebSocket._now() - this._rttAnchor, 0.0001);
		var numBytes = this._flowBytesSent - this._rttPreviousPosition;
		var bandwidth = numBytes / rtt;

		this._rttAnchor = undefined;
		this._rttPreviousPosition = this._flowBytesSent;

		this._smoothedRTT = ((this._smoothedRTT * 7) + rtt) / 8;
		this._addRTT(rtt);

		const adjustThresh = Math.max(this.minAckWindow * 2, this.minOutstandingThresh);
		if(numBytes >= adjustThresh - this.minAckWindow)
		{
			this.outstandingThresh = Math.max(
				this.minOutstandingThresh,
				bandwidth * (this.baseRTT + this.maxAdditionalDelay));

			if(this.outstandingThresh == this.minOutstandingThresh)
			{
				// reset measurements
				this._rttMeasurements = [{time:-Infinity, rtt: Infinity}];
				this._addRTT(rtt);
			}
		}
	}
}

RTWebSocket.prototype._addRTT = function(rtt) {
	var now = RTWebSocket._now();
	var entry = this._rttMeasurements[0];
	if(now - entry.time > this.rttHistoryThresh)
	{
		this._rttMeasurements.unshift({ time:now, rtt:rtt });

		var lastEntry;
		while( (lastEntry = this._rttMeasurements[this._rttMeasurements.length - 1])
		 && ((now - lastEntry.time) > (this.rttHistoryThresh * this.rttHistoryCapacity))
		)
		{
			this._rttMeasurements.pop();
		}

		this._baseRTTCache = this._rttMeasurements.reduce(function(l, r) { return Math.min(l, r.rtt); }, Infinity);
	}
	else
	{
		entry.rtt = Math.min(entry.rtt, rtt);
	}

	this._baseRTTCache = Math.min(this._baseRTTCache, rtt);
}

RTWebSocket.prototype._intervalWork = function() {
	this._transmit();
	this._sendAcks();
}

; (function() {
function VLU() {}

VLU.makeVLU = function(num) {
	var rv = [];
	var more = 0;
	do {
		var digit = num & 0x7f;
		rv.push(digit + more);
		num = (num - digit) / 128;
		more = 128;
	} while (num >= 1);
	rv.reverse();
	return rv;
}

VLU.parseVLU = function(bytes, cursor, limit, out, outName) {
	var acc = 0;
	var length = 0;

	if(limit < 0)
		limit = bytes.length;
	limit = Math.min(limit, bytes.length);

	while(cursor < limit)
	{
		acc = acc * 128;
		acc += bytes[cursor] & 0x7f;
		length++;
		if(0 == (bytes[cursor] & 0x80))
			break;
		cursor++;
	}

	if(cursor >= limit)
		throw new ReferenceError("incomplete VLU");

	if(out)
	{
		outName = outName || "value";
		out[outName] = acc;
	}

	return length;
}

RTWebSocket.prototype.makeVLU = VLU.makeVLU;
RTWebSocket.prototype.parseVLU = VLU.parseVLU;

function UTF8() {}

UTF8.prototype.encode = function(str) {
	var coder = String.prototype.codePointAt || String.prototype.charCodeAt;
	var rv = [];
	for(var x = 0; x < str.length; x++)
	{
		var c = coder.call(str, x);
		if(c < 0x80)
			rv.push(c);
		else if(c < 0x800)
		{
			rv.push(((c >> 6) & 0x1f) + 0xc0);
			rv.push((c & 0x3f) + 0x80);
		}
		else if(c < 0x10000)
		{
			rv.push(((c >> 12) & 0x0f) + 0xe0);
			rv.push(((c >>  6) & 0x3f) + 0x80);
			rv.push(((c      ) & 0x3f) + 0x80);
		}
		else if(c < 0x110000)
		{
			rv.push(((c >> 18) & 0x07) + 0xf0);
			rv.push(((c >> 12) & 0x3f) + 0x80);
			rv.push(((c >>  6) & 0x3f) + 0x80);
			rv.push(((c      ) & 0x3f) + 0x80);
		}
	}
	return rv;
}

UTF8.prototype.decode = function(bytes, cursor, limit) {
	var rv = [];

	cursor = cursor || 0;
	if((limit < 0) || (undefined == limit))
		limit = bytes.length;
	limit = Math.min(limit, bytes.length);

	while(cursor < limit)
	{
		var c = bytes[cursor];
		if(c < 0x80)
		{
			rv.push(String.fromCharCode(c));
			cursor++;
		}
		else if((c & 0xe0) == 0xc0)
		{
			if(limit - cursor > 1)
				rv.push(String.fromCharCode(((c & 0x1f) << 6) + (bytes[cursor+1] & 0x3f)));
			cursor += 2;
		}
		else if((c & 0xf0) == 0xe0)
		{
			if(limit - cursor > 2)
				rv.push(String.fromCharCode(((c & 0x0f) << 12) + ((bytes[cursor+1] & 0x3f) << 6) + (bytes[cursor+2] & 0x3f)));
			cursor += 3;
		}
		else if((c & 0xf8) == 0xf0)
		{
			if((limit - cursor > 3) && String.fromCodePoint)
				rv.push(String.fromCodePoint(((c & 0x07) << 18) + ((bytes[cursor+1] & 0x3f) << 12) + ((bytes[cursor+2] & 0x3f) << 6) + (bytes[cursor+3] & 0x3f)));
			cursor += 4;
		}
		else cursor++; // invalid UTF-8
	}

	return rv.join("");
}

RTWebSocket.prototype.UTF8 = new UTF8();

function Flow(owner) {
	this._owner = owner;
}

function SendFlow(owner, flowID, returnFlowID, metadata) {
	Flow.call(this, owner);
	this._flowID = flowID;
	this._priority = owner.PRI_ROUTINE;
	this._sendBuffer = [];
	this._sendBufferByteLength = 0;
	this._sentByteCount = 0;
	this._sendThroughAllowed = this.rcvbuf;
	this._open = true;
	this._writablePending = false;
	this._shouldNotifyWhenWritable = false;
	this._ackedPosition = 0;
	this._nextMessageNumber = 1;

	metadata = metadata || "";
	if(typeof(metadata) == "string")
		metadata = owner.UTF8.encode(metadata);
	metadata = Array.prototype.slice.call(new Uint8Array(metadata)); // convert to byte[]

	var flowIDVLU = VLU.makeVLU(flowID);

	this._flowOpenMessage = new Uint8Array([ returnFlowID >= 0 ? RTWebSocket.MSG_FLOW_OPEN_RETURN : RTWebSocket.MSG_FLOW_OPEN ]
		.concat(flowIDVLU)
		.concat(returnFlowID >= 0 ? VLU.makeVLU(returnFlowID) : [])
		.concat(metadata));

	this._flowCloseMessage = [RTWebSocket.MSG_FLOW_CLOSE].concat(flowIDVLU);
}
SendFlow.prototype = Object.create(Flow.prototype);
SendFlow.prototype.constructor = SendFlow;

SendFlow.prototype._sndbuf = 65536;
SendFlow.prototype.rcvbuf = 65536;

Object.defineProperties(SendFlow.prototype, {
	priority: {
		get: function() { return this._priority; },
		set: function(val) {
			if(val < this._owner.PRI_LOWEST)
				val = this._owner.PRI_LOWEST;
			if(val > this._owner.PRI_HIGHEST)
				val = this._owner.PRI_HIGHEST;
			if(!this._owner._transmissionWork[val])
				val = this._owner.PRI_ROUTINE;
			
			this._priority = val;
			this._owner._queueTransmission(this);
		},
		enumerable: true
	},
	sndbuf: {
		get: function() { return this._sndbuf; },
		set: function(val) {
			this._sndbuf = val;
			this._queueWritableNotify();
		},
		enumerable: true
	},
	bufferLength: {
		get: function() { return this._sendBufferByteLength; },
		enumerable: true
	},
	writable: {
		get: function() { return this.isOpen && (this.bufferLength < this.sndbuf); },
		enumerable: true
	},
	unsentAge: {
		get: function() { return this._getUnsentAge(); },
		enumerable: true
	},
	isOpen: {
		get: function() { return this._open; },
		enumerable: true
	},
});

SendFlow.prototype.write = function(bytes, startWithin, endWithin, capture) {
	if(!this._open)
		throw new Error("write: flow is closed");

	if(typeof(bytes) == "string")
		bytes = this._owner.UTF8.encode(bytes);

	if((!capture) && (bytes instanceof ArrayBuffer))
	{
		bytes = new Uint8Array(new Uint8Array(bytes));
		capture = true;
	}

	if(!(bytes instanceof Uint8Array))
	{
		bytes = new Uint8Array(bytes);
		capture = true;
	}

	var receipt = new WriteReceipt(this._nextMessageNumber, startWithin, endWithin);

	var message = new WriteMessage(bytes, capture, receipt);
	this._sendBuffer.push(message);
	this._sendBufferByteLength += bytes.length;
	this._nextMessageNumber++;

	this._queueTransmission();
	return receipt;
}

SendFlow.prototype.close = function() {
	if(!this._open)
		return;
	this._open = false;
	this._queueTransmission();
}

SendFlow.prototype.abandonQueuedMessages = function(age, onlyUnstarted) {
	age = age || 0;
	onlyUnstarted = onlyUnstarted || false;
	for(var x = 0; x < this._sendBuffer.length; x++)
	{
		var message = this._sendBuffer[x];
		if(message.receipt.age >= age)
		{
			if((!onlyUnstarted) || (!message.receipt.started))
				message.receipt.abandon();
		}
		else
			break;
	}
	this._queueTransmission();
}

SendFlow.prototype.notifyWhenWritable = function() {
	this._shouldNotifyWhenWritable = true;
	this._queueWritableNotify();
}

SendFlow.prototype.onexception = function(sender, code, description) {
	console.log("SendFlow onexception", sender, code, description);
}

SendFlow.prototype.onwritable = function(sender) { console.log("onwritable", sender); }

SendFlow.prototype.onrecvflow = function(recvFlow) { console.log("onrecvflow", recvFlow); }

SendFlow.prototype._queueWritableNotify = function() {
	if(this._shouldNotifyWhenWritable && !this._writablePending)
	{
		Promise.resolve().then(this._doWritable.bind(this));
		this._writablePending = true;
	}	
}

SendFlow.prototype._doWritable = function() {
	this._writablePending = false;
	while(this._shouldNotifyWhenWritable && this.writable)
	{
		this._shouldNotifyWhenWritable = false;
		try { if(this.onwritable) this._shouldNotifyWhenWritable = !! this.onwritable(this); }
		catch(e) { console.log("exception calling SendFlow.onwritable", e); }
	}
}

SendFlow.prototype._getUnsentAge = function() {
	for(var x = 0; x < this._sendBuffer.length; x++)
	{
		var message = this._sendBuffer[x];
		if(!message.receipt.abandoned)
			return message.receipt.age;
	}
	return 0;
}

SendFlow.prototype._transmit = function(priority) {
	if(priority != this.priority)
		return false;

	if(this._flowOpenMessage)
	{
		this._owner._sendBytes(this._flowOpenMessage);
		this._flowOpenMessage = undefined;
		return true;
	}

	var abandonCount = this._trimSendBuffer();
	if(abandonCount > 0)
	{
		var abandonMessage = [RTWebSocket.MSG_DATA_ABANDON].concat(VLU.makeVLU(this._flowID));
		if(abandonCount > 1)
			abandonMessage = abandonMessage.concat(VLU.makeVLU(abandonCount - 1));
		this._owner._sendBytes(abandonMessage);
		this._queueWritableNotify();
		return true;
	}

	if((0 == this._sendBuffer.length) && (!this._open) && (this._flowCloseMessage))
	{
		this._owner._sendBytes(this._flowCloseMessage);
		this._flowCloseMessage = undefined;
		return true;
	}

	if(this._sentByteCount >= this._sendThroughAllowed)
		return false;

	return this._transmitOneFragment();
}

SendFlow.prototype._trimSendBuffer = function() {
	var message;
	var abandonCount = 0;

	while((message = this._sendBuffer[0]))
	{
		if(message.receipt.abandoned)
		{
			message.receipt.abandon();
			abandonCount++;
			this._sendBufferByteLength -= message.bytes.length;
			this._sendBuffer.shift();
		}
		else
			break;
	}
	return abandonCount;
}

SendFlow.prototype._transmitOneFragment = function() {
	var message = this._sendBuffer[0];
	if((!message) || (message.receipt.abandoned))
		return false;

	var chunkSize = Math.max(0, Math.min(this._owner.chunkSize, this._sendThroughAllowed - this._sentByteCount));
	if(0 == chunkSize)
		return false;

	var from = message.offset;
	var to = Math.min(from + chunkSize, message.bytes.length);
	var fragment = message.bytes.subarray(from, to);
	var isLast = (to == message.bytes.length);
	var header = [isLast ? RTWebSocket.MSG_DATA_LAST : RTWebSocket.MSG_DATA_MORE]
		.concat(VLU.makeVLU(this._flowID));

	var fragmentMessage = new Uint8Array(header.length + fragment.length);
	fragmentMessage.set(header, 0);
	fragmentMessage.set(fragment, header.length);

	this._owner._sendBytes(fragmentMessage);
	this._sentByteCount += fragmentMessage.length;
	this._owner._flowBytesSent += fragmentMessage.length;
	message.offset = to;
	message.receipt._onStarted();

	if(isLast)
	{
		message.receipt._onSent();
		this._sendBuffer.shift();
		this._sendBufferByteLength -= message.bytes.length;
		this._queueWritableNotify();
	}

	return true;
}

SendFlow.prototype._onAck = function(deltaBytes, bufferAdvertisement) {
	this._owner._flowBytesAcked += deltaBytes;
	this._ackedPosition += deltaBytes;
	this.rcvbuf = bufferAdvertisement;
	this._sendThroughAllowed = this._ackedPosition + bufferAdvertisement;
	this._owner._measureRTT();
	this._queueTransmission();
	this._queueWritableNotify();
}

SendFlow.prototype._onExceptionMessage = function(code, description) {
	this.close();
	this.abandonQueuedMessages(-Infinity);

	try { if(this.onexception) this.onexception(this, code, description); }
	catch(e) { console.log("error sending onexception", e); }

	this._queueTransmission();
}

SendFlow.prototype._queueTransmission = function() { this._owner._queueTransmission(this); }

function WriteReceipt(messageNumber, startWithin, endWithin) {
	this._origin = RTWebSocket._now();
	this._abandoned = false;
	this._sent = false;
	this._started = false;
	this._startBy = (startWithin ?? Infinity) + this._origin;
	this._endBy = (endWithin ?? Infinity) + this._origin;
	this._messageNumber = messageNumber;
}

WriteReceipt.prototype.onsent = function(sender) {}
WriteReceipt.prototype.onabandoned = function(sender) {}
WriteReceipt.prototype.parent = null;

Object.defineProperties(WriteReceipt.prototype, {
	abandoned: {
		get: function() { return this._isAbandoned(); },
		enumerable: true
	},
	startBy: {
		get: function() { return this._startBy; },
		set: function(val) { this._startBy = (typeof(val) == "number") ? val : Infinity; },
		enumerable: true
	},
	endBy: {
		get: function() { return this._endBy; },
		set: function(val) { this._endBy = (typeof(val) == "number") ? val : Infinity; },
		enumerable: true
	},
	sent: {
		get: function() { return this._sent; },
		enumerable: true
	},
	started: {
		get: function() { return this._started; },
		enumerable: true
	},
	age: {
		get: function() { return RTWebSocket._now() - this._origin; },
		enumerable: true
	},
	messageNumber: {
		get: function() { return this._messageNumber; },
		enumerable: true
	},
	createdAt: {
		get: function() { return this._origin; },
		enumerable: true
	},
	finished: {
		get: function() { return this._sent || this._abandoned },
		enumerable: true
	}
});

WriteReceipt.prototype.abandon = function() {
	if((!this._abandoned) && !this._sent)
	{
		this._abandoned = true;
		this.parent = null;
		var self = this;
		if(this.onabandoned)
			Promise.resolve().then(function() { self.onabandoned(self); } );
	}
}

WriteReceipt.prototype.setStartWithin = function(val) {
	this._startBy = this._origin + val;
}

WriteReceipt.prototype.setFinishWithin = function(val) {
	this._endBy = this._origin + val;
}

WriteReceipt.prototype._isAbandoned = function() {
	if(this._abandoned)
		return true;
	if(this._sent)
		return false;
	var now = RTWebSocket.getCurrentTime();
	if( (now > this._endBy)
	 || ((!this._started) && (now > this._startBy))
	 || (this.parent?.abandoned)
	)
		this.abandon();
	return this._abandoned;
}

WriteReceipt.prototype._onStarted = function() { this._started = true; }

WriteReceipt.prototype._onSent = function() {
	var self = this;
	this._sent = true;
	if(this.onsent) Promise.resolve().then(function() { self.onsent(self); } );
}

function WriteReceiptChain() {
	this._receipts = [];
}

WriteReceiptChain.prototype.append = function(receipt) {
	receipt.parent = this._receipts[this._receipts.length - 1] || null;
	this._receipts.push(receipt);

	while(this._receipts[0]?.finished)
		this._receipts.shift();
}

WriteReceiptChain.prototype.expire = function(startDeadline, finishDeadline) {
	for(let each of this._receipts)
	{
		each.startBy = Math.min(each.startBy, startDeadline);
		each.endBy = Math.min(each.endBy, finishDeadline ?? startDeadline);
	}
	this._receipts = [];
}

function WriteMessage(bytes, capture, receipt) {
	this.bytes = capture ? bytes : new Uint8Array(bytes);
	this.receipt = receipt;
	this.offset = 0;
}

function ReadMessage(messageNumber) {
	this.messageNumber = messageNumber;
	this.fragments = [];
	this.totalLength = 0;
	this.complete = false;
}

ReadMessage.prototype.addFragment = function(more, bytes) {
	this.fragments.push(bytes);
	this.totalLength += bytes.length;
	if(!more)
		this.complete = true;
}

ReadMessage.prototype.getFullMessage = function() {
	if(1 == this.fragments.length)
		return this.fragments[0];

	var rv = new Uint8Array(this.totalLength);
	var cursor = 0;
	for(var x = 0; x < this.fragments.length; x++)
	{
		var fragment = this.fragments[x];
		rv.set(fragment, cursor);
		cursor += fragment.length;
	}

	return rv;
}

function RecvFlow(owner, flowID, metadata, associatedSendFlow) {
	Flow.call(this, owner);
	this._flowID = flowID;
	this._metadata = metadata;
	this._associatedSendFlow = associatedSendFlow;
	this._userOpen = false;
	this._open = true;
	this._paused = false;
	this._receiveBuffer = [];
	this._receiveBufferByteLength = 0;
	this._receivedByteCount = 0;
	this._ackThresh = 0;
	this._complete = false;
	this._sentComplete = false;
	this._sentCloseAck = false;
	this._nextMessageNumber = 1;
	this._deliveryPending = false;
	this._mode = "binary";
}
RecvFlow.prototype = Object.create(Flow.prototype);
RecvFlow.prototype.constructor = RecvFlow;

RecvFlow.prototype._rcvbuf = 2097151;

Object.defineProperties(RecvFlow.prototype, {
	rcvbuf: {
		get: function() { return this._rcvbuf; },
		set: function(val) {
			if(val != this._rcvbuf)
				this._queueAck(true);
			this._rcvbuf = Math.max(val, 0) || 0;
		},
		enumerable: true
	},
	paused: {
		get: function() { return this._paused; },
		set: function(val) {
			var wasPaused = this._paused;
			this._paused = !!val;
			if(!this._paused)
			{
				this._queueDelivery();
				if(wasPaused)
					this._queueAck(true);
			}
		},
		enumerable: true
	},
	bufferLength: {
		get: function() { return this._receiveBufferByteLength; },
		enumerable: true
	},
	associatedSendFlow: {
		get: function() {
			return this._associatedSendFlow;
		},
		enumerable: true
	},
	isOpen: {
		get: function() { return this._open && this._userOpen; },
		enumerable: true
	},
	metadata: {
		get: function() { return new Uint8Array(this._metadata); },
		enumerable: true
	},
	textMetadata: {
		get: function() { return this._owner.UTF8.decode(this._metadata); },
		enumerable: true
	},
	advertisement: {
		get: function() { return this.paused ? Math.max(this.rcvbuf - this.bufferLength, 0) : this.rcvbuf; },
		enumerable: true
	},
	mode: {
		get: function() { return this._mode; },
		set: function(val) { this._mode = ("text" == val) ? val : "binary"; },
		enumerable: true
	},
});

RecvFlow.prototype.close = function(code, description) {
	if(!this._open)
		return;

	this._userOpen = this._open = false;
	this.rcvbuf = 0;

	if(this._complete)
		return;

	var bytes = [RTWebSocket.MSG_FLOW_EXCEPTION];
	bytes = bytes.concat(VLU.makeVLU(this._flowID));
	if(code >= 0)
	{
		bytes = bytes.concat(VLU.makeVLU(code));
		if(description)
			bytes = bytes.concat(this._owner.UTF8.encode(description));
	}
	this._owner._sendBytes(bytes);
}

RecvFlow.prototype.accept = function() {
	if(this._open)
		this._userOpen = true;
}

RecvFlow.prototype.openReturnFlow = function(metadata, pri) {
	if((!this.isOpen) || (this._complete))
		return undefined;
	return this._owner._basicOpenFlow(metadata, pri, this._flowID);
}

RecvFlow.prototype.onmessage = function(sender, message, num) {
	console.log("RecvFlow onmessage #" + num, sender, message);
}

RecvFlow.prototype.oncomplete = function(sender) { console.log("RecvFlow complete", sender); }

RecvFlow.prototype._queueAck = function(immediate) { this._owner._queueAck(this, immediate); }

RecvFlow.prototype._sendAck = function() {
	if(this._sentCloseAck)
		return;

	var advertisement = this.advertisement;
	this._ackThresh = advertisement / 2;

	var bytes = [RTWebSocket.MSG_DATA_ACK]
		.concat(VLU.makeVLU(this._flowID))
		.concat(VLU.makeVLU(this._receivedByteCount))
		.concat(VLU.makeVLU(advertisement));
	this._owner._sendBytes(bytes);

	this._receivedByteCount = 0;

	if(this._complete)
	{
		this._owner._sendBytes([RTWebSocket.MSG_FLOW_CLOSE_ACK].concat(VLU.makeVLU(this._flowID)));
		this._sentCloseAck = true;
	}
}

RecvFlow.prototype._onFlowCloseMessage = function() {
	this._complete = true;
	this._onDataAbandon(0);
	this._queueDelivery();
	this._queueAck(true);
}

RecvFlow.prototype._onData = function(more, msgFragment, chunkLength) {
	this._receivedByteCount += chunkLength;
	this._receiveBufferByteLength += msgFragment.length;

	var message = this._receiveBuffer[this._receiveBuffer.length - 1];
	if((!message) || (message.complete))
	{
		message = new ReadMessage(this._nextMessageNumber++);
		this._receiveBuffer.push(message);
	}

	message.addFragment(more, msgFragment);
	if(message.complete)
		this._queueDelivery();

	this._queueAck(this._receivedByteCount >= this._ackThresh);
}

RecvFlow.prototype._onDataAbandon = function(countMinusOne) {
	var count = countMinusOne + 1;
	var message = this._receiveBuffer[this._receiveBuffer.length - 1];
	if(message && !message.complete)
	{
		this._receiveBuffer.pop();
		this._receiveBufferByteLength -= message.totalLength;
		count--;
	}

	this._nextMessageNumber += count;

	this._queueAck(true);
}

RecvFlow.prototype._queueDelivery = function() {
	if((!this._deliveryPending) && (!this.paused))
	{
		Promise.resolve().then(this._deliverData.bind(this));
		this._deliveryPending = true;
	}
}

RecvFlow.prototype._deliverData = function() {
	var anyUnqueued = false;
	this._deliveryPending = false;
	while(this._receiveBuffer.length)
	{
		if(this.paused || !this.isOpen)
			break;
		var message = this._receiveBuffer[0];
		if(!message.complete)
			break;

		this._receiveBuffer.shift();
		this._receiveBufferByteLength -= message.totalLength;
		anyUnqueued = true;

		var fullMessage = message.getFullMessage();
		if("text" == this._mode)
			fullMessage = this._owner.UTF8.decode(fullMessage);

		try { if(this.onmessage) this.onmessage(this, fullMessage, message.messageNumber); }
		catch(e) { console.log("exception calling RecvFlow.onmessage()", e); }
	}

	if(this._complete)
	{
		if(!this._sentComplete)
		{
			this._sentComplete = true;
			try { if(this.isOpen && this.oncomplete) this.oncomplete(this); }
			catch(e) { console.log("exception calling RecvFlow.oncomplete()", e); }
			this.close();
		}
	}
}

class FlowSyncManager {
	constructor() {
		this._barriers = {};
	}

	sync(syncID, count, flow) {
		const flows = this._barriers[syncID] || [];
		this._barriers[syncID] = flows;

		flow.paused = true;

		flows.push(flow);
		if(flows.length >= count)
		{
			this._resumeFlows(syncID);
			return true;
		}

		return false;
	}

	reset() {
		const keys = Object.keys(this._barriers);
		var each;
		while((each = keys.shift()))
			this._resumeFlows(each);
	}

	close() { this.reset(); }

	_resumeFlows(syncID) {
		const flows = this._barriers[syncID];
		var each;
		while((each = flows.shift()))
			each.paused = false;
		delete this._barriers[syncID];
	}
}

RTWebSocket.prototype._SendFlow = SendFlow;
RTWebSocket.prototype._RecvFlow = RecvFlow;
RTWebSocket.FlowSyncManager = FlowSyncManager;
RTWebSocket.WriteReceiptChain = WriteReceiptChain;

})();
