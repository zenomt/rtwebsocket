// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

function com_zenomt_TCConnection() {
	this._url = null;
	this._userOpen = true;
	this._tcOpen = false;
	this._rtws = null;
	this._nextTID = 1;
	this._transactions = {};
	this._controlSend = null;
	this._controlRecv = null;
	this._openPromiseControl = null;
	this._streams = {};
	this._syncManager = new RTWebSocket.FlowSyncManager();

	this.client = {};
}

; (function() {

const TC = com_zenomt_TCMessage;
const AMF0 = com_zenomt_AMF0;
const Connection = com_zenomt_TCConnection;
Connection.prototype.constructor = Connection;

Object.defineProperties(Connection.prototype, {
	isOpen: { get: function() { return this._userOpen && this._tcOpen; }, enumerable: true }
});


Connection.prototype.onstatus = function(e) { console.log("Connection.onstatus", e); }
Connection.prototype.onclose = function() { console.log("Connection.onclose"); }

Connection.prototype.connect = function(wsurl, argObject, ...args) {
	if(this._rtws)
		throw new Error("connect already called");

	argObject = Object.create(argObject || {});
	argObject.objectEncoding = argObject.objectEncoding || 0;
	argObject.tcUrl = argObject.tcUrl || wsurl;
	if((!argObject.app) && ("" != argObject.app))
	{
		const url = new URL(argObject.tcUrl);
		argObject.app = ("/" == url.pathname[0]) ? url.pathname.substr(1) : url.pathname;
	}

	// deep copy, ensures AMF0 compatible early
	const connectPayload = AMF0.decodeMany(AMF0.encodeMany(argObject, ...args));

	this._rtws = new RTWebSocket(wsurl);
	const myself = this;
	return new Promise(function(resolve, reject) {
		myself._openPromiseControl = { resolve, reject };
		myself._rtws.onopen = function() { myself._onRTWSOpen(connectPayload); };
		myself._rtws.onclose = function() { myself.close(true); };
	});
}

Connection.prototype.command = function(method, ...args) {
	if(!this.isOpen)
		throw new Error("not open");

	switch(method)
	{
	case "createStream":
	case "deleteStream":
	case "connect":
		throw new RangeError("method " + method + " not allowed");

	default:
		return this._command(method, ...args);
	}
}

Connection.prototype.createStream = function() {
	if(!this.isOpen)
		throw new Error("not open");

	const myself = this;
	return new Promise(function(resolve, reject) {
		myself._transact(function(success, streamID) {
			if(success)
				resolve(myself._streams[streamID] = new Stream(myself, streamID));
			else
				reject();
		}, "createStream", null);
	});
}

Connection.prototype.close = function(isError) {
	if(!this._userOpen)
		return;

	this._syncManager.close();

	if(isError && !this._tcOpen)
		_onStatusMessage(this, this, { level:"error", code:"NetConnection.Connect.Failed" });
	else
		_onStatusMessage(this, this, { level:"status", code:"NetConnection.Connect.Closed" });

	if(this._openPromiseControl)
		this._openPromiseControl.reject();
	this._openPromiseControl = null;

	const myself = this;

	this._userOpen = false;
	if(this._rtws)
		this._rtws.close();

	if(this.onclose)
		Promise.resolve().then(function() { myself.onclose(); });

	for(const each in this._transactions)
		this._transactions[each](false);
	this._transactions = null;

	const tmpStreams = this._streams;
	this._streams = {};
	for(const streamID in tmpStreams)
		tmpStreams[streamID].deleteStream();
}

// ---

Connection.prototype._command = function(method, ...args) {
	if(this.isOpen)
		return this._controlSend.write(TC.Message.make(TC.TCMSG_COMMAND, 0, AMF0.encodeMany(method, 0, ...args)));
}

Connection.prototype._transact = function(oncomplete, command, ...args) {
	const tid = this._nextTID++;
	this._controlSend.write(TC.Message.make(TC.TCMSG_COMMAND, 0, AMF0.encodeMany(command, tid, ...args)));
	this._transactions[tid] = oncomplete;
}

Connection.prototype._onRTWSOpen = function(connectPayload) {
	const myself = this;
	this._controlSend = this._rtws.openFlow(TC.Metadata.encode(0), this._rtws.PRI_IMMEDIATE);
	this._controlSend.onexception = function() { myself.close(true); };
	this._controlSend.onrecvflow = function(flow) { myself._onRecvFlow(flow); };
	this._transact(function(success, ...args) {
		if(!success)
			myself.close(true);
		else
		{
			const resolve = myself._openPromiseControl.resolve;
			myself._openPromiseControl = null;
			myself._tcOpen = true;
			resolve(...args);
			_onStatusMessage(myself, myself, ...args);
		}
	}, "connect", ...connectPayload);
}

Connection.prototype._onRecvFlow = function(flow) {
	const metadata = TC.Metadata.decode(flow.metadata);
	if(!metadata)
		return; // not TC
	if((!this._controlRecv) && (0 == metadata.streamID))
		this._acceptControl(flow);
	else if(!this._controlRecv)
		return this.close();
	else
		this._acceptOther(flow, metadata.streamID);
}

Connection.prototype._acceptControl = function(flow) {
	flow.accept();
	flow.oncomplete = this.close.bind(this);
	this._controlRecv = flow;
	this._setOnmessage(flow, 0);
}

Connection.prototype._acceptOther = function(flow, streamID) {
	if(streamID && !this._streams[streamID])
		return;

	flow.rcvbuf = (1 << 24) - 1;
	flow.accept();
	this._setOnmessage(flow, streamID);

	if(0 == streamID)
	{
		this._recvFlows.push(flow);
		flow.oncomplete = this._onFlowComplete.bind(this);
	}
	else
		this._streams[streamID]._onRecvFlow(flow);
}

Connection.prototype._onMessage = function(streamID, flow, message, messageNumber) {
	const header = TC.Message.decodeHeader(message);
	if(!header)
		return;

	switch(header.type)
	{
	case TC.TCMSG_COMMAND:
	case TC.TCMSG_COMMAND_EX:
		this._onCommandMessage(streamID, header, message);
		return;

	case TC.TCMSG_AUDIO:
	case TC.TCMSG_VIDEO:
	case TC.TCMSG_DATA:
	case TC.TCMSG_DATA_EX:
		if(streamID)
			this._streams[streamID]._onStreamMessage(header, message);
		return;

	case TC.TCMSG_USER_CONTROL:
		this._onUserControlMessage(header, message, flow);
		return;
	}
}

Connection.prototype._setOnmessage = function(flow, streamID) {
	const myself = this;
	flow.onmessage = function(f, message, messageNumber) { myself._onMessage(streamID, f, message, messageNumber); };
}

Connection.prototype._onFlowComplete = function(flow) {
	this._recvFlows.splice(this._recvFlows.indexOf(flow), 1);
}

Connection.prototype._onCommandMessage = function(streamID, header, message) {
	var cursor = header.consumed;
	if(message.length == cursor)
		return;
	if((TC.TCMSG_COMMAND_EX == header.type) && (0 != message[cursor++]))
		return;
	const args = AMF0.decodeMany(message, cursor);
	if((args.length < 2) || (typeof(args[0]) != "string") || (typeof(args[1]) != "number"))
		return;

	if(0 == streamID)
		this._onControlCommandMessage(...args);
	else
		this._streams[streamID]._onCommandMessage(...args);
}

Connection.prototype._onControlCommandMessage = function(command, tid, arg, ...args) {
	switch(command)
	{
	case "_result":
	case "_error":
		this._onTransactionResponse("_result" == command, tid, ...args);
		return;

	case "onStatus":
		_onStatusMessage(this, this, ...args);
		return;

	default:
		if(this.client && (typeof(this.client[command]) == "function"))
		{
			try { this.client[command](...args); }
			catch(e) { console.log("exception calling Connection.client." + command, e); }
		}
	}
}

Connection.prototype._onTransactionResponse = function(success, tid, ...args) {
	if(this._transactions[tid])
	{
		const handler = this._transactions[tid];
		delete this._transactions[tid];
		handler(success, ...args);
	}
}

Connection.prototype._deleteStream = function(streamID) {
	if(this._streams[streamID])
	{
		delete this._streams[streamID];
		this._command("deleteStream", null, streamID);
	}
}

Connection.prototype._onUserControlMessage = function(header, message, flow) {
	const limit = message.length;
	let cursor = header.consumed;
	if(limit - cursor < 2)
		return;

	var eventType = message[cursor] * 256 + message[cursor + 1];
	cursor += 2;

	switch(eventType)
	{
	case TC.TC_USERCONTROL_FLOW_SYNC:
		this._onFlowSyncMessage(message, cursor, limit, flow);
		return;
	}
}

Connection.prototype._onFlowSyncMessage = function(message, cursor, limit, flow) {
	if(limit - cursor < 8)
		return;

	var syncID;
	var count;

	syncID = message[cursor++]; syncID *= 256;
	syncID += message[cursor++]; syncID *= 256;
	syncID += message[cursor++]; syncID *= 256;
	syncID += message[cursor++];

	count = message[cursor++]; count *= 256;
	count += message[cursor++]; count *= 256;
	count += message[cursor++]; count *= 256;
	count += message[cursor++];

	this._syncManager.sync(syncID, count, flow);
}

function _onStatusMessage(receiver, target, info) {
	if(receiver.onstatus)
	{
		const event = { type:"netStatus", target, bubbles:false, cancelable:false, eventPhase:2, info };
		try { receiver.onstatus(event); }
		catch(e) { console.log("exception calling onstatus", receiver, event, e); }
	}
}

// --- Stream

function Stream(owner, streamID) {
	this._owner = owner;
	this._streamID = streamID;
	this._isOpen = true;
	this._mode = "idle"; // idle, publish, play
	this._videoSend = null;
	this._audioSend = null;
	this._dataSend = null;
	this._recvFlows = [];

	this.client = {};
}
Stream.prototype.constructor = Stream;
Object.defineProperties(Stream.prototype, {
	isOpen: { get: function() { return this._isOpen; }, enumerable: true }
});
Stream.prototype.onstatus = function(e) { console.log("Stream.onstatus", e); }
Stream.prototype.onaudio = function(header, message) { console.log("Stream.onaudio", header); }
Stream.prototype.onvideo = function(header, message) { console.log("Stream.onaudio", header); }

Stream.prototype.publish = function(...args) {
	if(!this.isOpen)
		throw new Error("stream not open");
	this._mode = "publish";
	this._command("publish", null, ...args);
}

Stream.prototype.send = function(...args) {
	return this.sendWithTimestamp(0, ...args);
}

Stream.prototype.sendWithTimestamp = function(timestamp, ...args) {
	return this.sendMessage(undefined, TC.TCMSG_DATA, timestamp, AMF0.encodeMany(...args));
}

Stream.prototype.sendAudio = function(endBy, timestamp, ...byteses) {
	return this.sendMessage(endBy, TC.TCMSG_AUDIO, timestamp, ...byteses);
}

Stream.prototype.sendVideo = function(endBy, timestamp, ...byteses) {
	return this.sendMessage(endBy, TC.TCMSG_VIDEO, timestamp, ...byteses);
}

Stream.prototype.sendMessage = function(endBy, type, timestamp, ...byteses) {
	if(!this.isOpen)
		return;
	if("publish" != this._mode)
		throw new Error("not publishing");

	const flow = this._openFlowForType(type);
	if(flow)
		return flow.write(TC.Message.make(type, timestamp, ...byteses), endBy, endBy);
}

Stream.prototype.play = function(...args) {
	if(!this.isOpen)
		throw new Error("stream not open");
	this._mode = "play";
	this._command("play", null, ...args);
}

Stream.prototype.pause = function() {
	this._command("pause", null, true);
}

Stream.prototype.resume = function() {
	this._command("pause", null, false);
}

Stream.prototype.closeStream = function() {
	this._mode = "idle";
	this._command("closeStream", null);
}

Stream.prototype.deleteStream = function() {
	this._isOpen = false;
	this._owner._deleteStream(this._streamID);

	if(this._videoSend) this._videoSend.close();
	if(this._audioSend) this._audioSend.close();
	if(this._dataSend) this._dataSend.close();

	var flow;
	while((flow = this._recvFlows.shift()))
		flow.close(0, "deleting stream");
}

Stream.prototype.receiveAudio = function(flag, ...args) {
	this._command("receiveAudio", null, flag, ...args);
}

Stream.prototype.receiveVideo = function(flag, ...args) {
	this._command("receiveVideo", null, flag, ...args);
}

Stream.prototype._openFlowForType = function(messageType) {
	if(!this.isOpen)
		return;

	var pri = RTWebSocket.PRI_IMMEDIATE;
	var slot = "_dataSend";

	switch(messageType)
	{
	case TC.TCMSG_VIDEO:
		slot = "_videoSend";
		pri = RTWebSocket.PRI_PRIORITY;
		break;

	case TC.TCMSG_AUDIO:
		slot = "_audioSend";
		break;
	}

	if(!this[slot])
	{
		this[slot] = this._owner._controlRecv.openReturnFlow(TC.Metadata.encode(this._streamID), pri);
		this[slot].onexception = null;
	}

	return this[slot];
}

Stream.prototype._command = function(method, ...args) {
	const flow = this._openFlowForType(TC.TCMSG_COMMAND);
	if(flow)
		flow.write(TC.Message.make(TC.TCMSG_COMMAND, 0, AMF0.encodeMany(method, 0, ...args)));
}

Stream.prototype._onRecvFlow = function(flow) {
	flow.oncomplete = this._onFlowComplete.bind(this);
	this._recvFlows.push(flow);
}

Stream.prototype._onFlowComplete = function(flow) {
	this._recvFlows.splice(this._recvFlows.indexOf(flow), 1);
}

Stream.prototype._onCommandMessage = function(command, tid, arg, ...args) {
	if("onStatus" == command)
		_onStatusMessage(this, this, ...args);
}

Stream.prototype._onStreamMessage = function(header, message) {
	if(this._mode != "play")
		return;

	switch(header.type)
	{
	case TC.TCMSG_AUDIO:
		this._onAudioMessage(header, message);
		return;

	case TC.TCMSG_VIDEO:
		this._onVideoMessage(header, message);
		return;

	case TC.TCMSG_DATA:
	case TC.TCMSG_DATA_EX:
		this._onDataMessage(header, message);
		return;
	}
}

Stream.prototype._onVideoMessage = function(header, message) {
	if("function" != typeof(this.onvideo))
		return;
	if(0 == (message.length - header.consumed))
		return;

	let cursor = header.consumed;
	const limit = message.length;

	header.frametype = message[cursor] & TC.TC_VIDEO_FRAMETYPE_MASK;
	header.codec = message[cursor] & TC.TC_VIDEO_CODEC_MASK;
	header.presentationTime = header.timestamp;

	cursor++;

	if(TC.TC_VIDEO_CODEC_AVC == header.codec)
	{
		if(limit - cursor < 4) // AVCPacketType and Composition Time Offset
			return;

		header.isAVC = true;
		header.avcPacketType = message[cursor++];
		let compositionTimeOffset = message[cursor++]; compositionTimeOffset <<= 8;
		compositionTimeOffset += message[cursor++]; compositionTimeOffset <<= 8;
		compositionTimeOffset += message[cursor++];
		if(compositionTimeOffset & 0x00800000)
			compositionTimeOffset |= 0xff000000; // sign extend, JS treats as signed int32
		header.presentationTime = header.timestamp + compositionTimeOffset;
	}

	if(TC.TC_VIDEO_FRAMETYPE_COMMAND == header.frametype)
	{
		if(cursor >= limit)
			return;
		header.command = message[cursor++];
	}

	header.payloadOffset = cursor;

	try { this.onvideo(header, message); }
	catch(e) { console.log("exception calling Stream.onvideo", e); }
}

Stream.prototype._onAudioMessage = function(header, message) {
	if("function" != typeof(this.onaudio))
		return;

	if(0 == (message.length - header.consumed))
	{
		header.silence = true;
		header.payloadOffset = header.consumed;
	}
	else
	{
		let cursor = header.consumed;
		const limit = message.length;

		header.codec = message[cursor] & TC.TC_AUDIO_CODEC_MASK;
		header.rate = message[cursor] & TC.TC_AUDIO_RATE_MASK;
		header.soundSize = message[cursor] & TC.TC_AUDIO_SOUNDSIZE_MASK;
		header.sound = message[cursor] & TC.TC_SOUND_MASK;

		header.numberOfChannels = (TC.TC_AUDIO_SOUND_STEREO == header.sound) ? 2 : 1;

		switch(header.rate)
		{
		case TC.TC_AUDIO_RATE_11025: header.sampleRate = 11025; break;
		case TC.TC_AUDIO_RATE_22050: header.sampleRate = 22050; break;
		case TC.TC_AUDIO_RATE_44100: header.sampleRate = 44100; break;

		case TC.TC_AUDIO_RATE_5500:
			if((TC.TC_AUDIO_CODEC_G711_MU_LAW == header.codec) || (TC.TC_AUDIO_CODEC_G711_A_LAW == header.codec))
				header.sampleRate = 8000;
			else
				header.sampleRate = 5500;
			break;
		}

		cursor++;

		if(TC.TC_AUDIO_CODEC_AAC == header.codec)
		{
			if(cursor >= limit)
				return;

			header.isAAC = true;
			header.aacPacketType = message[cursor];
			cursor++;
		}
		else
			header.isAAC = false;

		header.payloadOffset = cursor;
	}

	try { this.onaudio(header, message); }
	catch(e) { console.log("exception calling Stream.onaudio", e); }
}

Stream.prototype._onDataMessage = function(header, message) {
	var cursor = header.consumed;
	if(message.length == cursor)
		return;
	if((TC.TCMSG_DATA_EX == header.type) && (0 != message[cursor++]))
		return;
	const args = AMF0.decodeMany(message, cursor);
	if(typeof(args[0]) != "string") // includes empty args
		return;

	// TODO schedule delivery by timestamp, probably this works the same as audio and video
	const command = args.shift();
	if(this.client && (typeof(this.client[command]) == "function"))
	{
		try { this.client[command](...args); }
		catch(e) { console.log("exception calling Stream.client." + command, e); }
	}
}

})();
