// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

class com_zenomt_TCAudioSourceNode extends AudioWorkletNode {
	constructor(context, channelCount) {
		super(context, 'com_zenomt_TCAudioSourceNodeProcessor', {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			channelCount: channelCount || 1
		});

		this._nextFlushID = 0;
		this._sampleRate = context.sampleRate;
		this._lastTimestamp = 0;
		this._totalFramesProcessed = 0;
		this._totalFramesAppended = 0;
		this._bufferTime = 0;
		this._pendingFlushes = {};
		this._lastAppendedDuration = 0;

		this._minimumBufferLengthNumberOfBuckets = 8;
		this.resetMinimumBufferLength();

		this.port.onmessage = (event) => { this._onMessage(event); };
	}

	static register(context) {
		return context.audioWorklet.addModule("tcaudioprocessor.js");
	}

	static convertAudioDataToPlanes(audioData) {
		const planes = [];
		for(let channel = 0; channel < audioData.numberOfChannels; channel++)
		{
			const plane = new Float32Array(audioData.numberOfFrames);
			audioData.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
			planes.push(plane);
		}
		return planes;
	}

	appendSamples(planes, timestamp) {
		if(planes && planes[0])
		{
			this._totalFramesAppended += planes[0].length;
			if(planes[0].length)
				this._lastAppendedDuration = planes[0].length / this._sampleRate;
			this.port.postMessage({ command: "buffer", planes, timestamp, insertionTime: this.context.currentTime });
		}
	}

	appendAudioDataWithTimestamp(audioData, timestamp) {
		return this.appendSamples(this.constructor.convertAudioDataToPlanes(audioData), timestamp);
	}

	appendAudioData(audioData) { return this.appendAudioDataWithTimestamp(audioData, audioData.timestamp / 1000000.0); }

	silence(timestamp) { this.port.postMessage({ command: "silence", timestamp: timestamp }); }

	clear() { this.port.postMessage({ command: "clear" }); }

	flush() {
		const flushID = this._nextFlushID++;
		this.port.postMessage({ command: "flush", flushID });

		const myself = this;
		return new Promise(function(resolve, reject) { myself._pendingFlushes[flushID] = { resolve, reject }; });
	}

	get currentTime() { return this._lastTimestamp; }

	get bufferLength() { return (this._totalFramesAppended - this._totalFramesProcessed) / this._sampleRate; }

	get bufferTime() { return this._bufferTime; }

	set bufferTime(val) {
		this._bufferTime = val;
		this.port.postMessage({ command: "setBufferTime", bufferTime: val || 0 });
	}

	get lastAppendedDuration() { return this._lastAppendedDuration; }

	resetMinimumBufferLength(windowDuration) {
		windowDuration = Number(windowDuration) || 8;
		this._minimumBufferLengthWindowDuration = windowDuration;
		this._minimumBufferLengthBucketDuration = windowDuration / this._minimumBufferLengthNumberOfBuckets;
		this._minimums = [{ time:-Infinity, minimum:Infinity }];
		this._cachedMinimumBufferLength = Infinity;
	}

	get minimumBufferLength() { return this._cachedMinimumBufferLength; }

	isOverbuffered() {
		const bufferLength = this.bufferLength;

		return ( (this._lastAppendedDuration > 0)
		      && (bufferLength > this._bufferTime + 4 * this._lastAppendedDuration)
		      && (this._cachedMinimumBufferLength > this._bufferTime + 3 * this._lastAppendedDuration)
		      && (bufferLength > this._bufferTime + this._cachedMinimumBufferLength + 2 * this._lastAppendedDuration)
		);
	}

	_addBufferLengthMeasurement(value) {
		const now = window.performance.now() / 1000.0;
		const entry = this._minimums[0];
		const historyThresh = this._minimumBufferLengthWindowDuration;
		if(now - entry.time > this._minimumBufferLengthBucketDuration)
		{
			this._minimums.unshift({ time:now, minimum:value });

			var lastEntry;
			while( (lastEntry = this._minimums[this._minimums.length - 1])
			    && (now - lastEntry.time > historyThresh)
			)
				this._minimums.pop();

			this._cachedMinimumBufferLength = this._minimums.reduce(function(l, r) { return Math.min(l, r.minimum); }, Infinity);
		}
		else
			entry.minimum = Math.min(entry.minimum, value);

		this._cachedMinimumBufferLength = Math.min(this._cachedMinimumBufferLength, value);
	}

	_onFlush(info) {
		if(info && this._pendingFlushes[info.flushID])
		{
			this._pendingFlushes[info.flushID].resolve();
			delete this._pendingFlushes[info.flushID];
		}
	}

	_sendOnStatusMessage(code, level) {
		if(this.onstatus)
		{
			const event = { type:"netStatus", target:this, bubbles:false, cancelable:false, eventPhase:2, info: { code, level } };
			try { this.onstatus(event); }
			catch(e) { console.log("exception calling onstatus", this, event, e); }
		}
	}

	_onMessage(event) {
		const data = event.data;
		if(!data)
			return;

		if(undefined != data.timestamp)
			this._lastTimestamp = data.timestamp;
		if(undefined != data.totalFramesProcessed)
		{
			this._totalFramesProcessed = data.totalFramesProcessed;
			this._addBufferLengthMeasurement(this.bufferLength);
		}

		if(data.event)
		{
			if("NetStream.Buffer.Flush" == data.event)
				this._onFlush(data.info);

			this._sendOnStatusMessage(data.event, "status");
		}
	}
};

class com_zenomt_SimpleAudioController {
	constructor() {
		this._buffer = [];
		this._gain = 1.0;
		this._bufferTime = 0.0;
		this._currentChannelCount = null;
		this._gainNode = null;
		this._tcSourceNode = null;
		this._context = null;
		this._primed = false;
		this._pipelinePending = false;
		this._savedTimestamp = undefined;
		this._lastAppendedDuration = 0;
	}

	get gain() { return this._gain; }
	set gain(value) {
		this._gain = value;
		if(this._gainNode)
			this._gainNode.gain.value = value;
	}

	get currentTime() { return this._tcSourceNode ? this._tcSourceNode.currentTime : 0; }

	get bufferTime() { return this._bufferTime; }
	set bufferTime(value) {
		this._bufferTime = value;
		if(this._tcSourceNode)
			this._tcSourceNode.bufferTime = value;
	}

	get bufferLength() {
		return this._buffer.reduce((acc, each) => acc + (each.duration || 0), 0) + (this._tcSourceNode ? this._tcSourceNode.bufferLength : 0);
	}

	appendSamples(planes, sampleRate, timestamp) {
		if(!(sampleRate > 0))
			throw new RangeError("sample rate must be greater than 0");

		const duration = planes[0].length / sampleRate;
		if(duration)
			this._lastAppendedDuration = duration;

		this._primed = true;
		this._buffer.push({
			command: "buffer",
			planes,
			sampleRate,
			timestamp,
			duration
		});
		this._processBuffer();
	}

	appendAudioDataWithTimestamp(audioData, timestamp) {
		const planes = com_zenomt_TCAudioSourceNode.convertAudioDataToPlanes(audioData);
		return this.appendSamples(planes, audioData.sampleRate, timestamp);
	}

	appendAudioData(audioData) {
		return this.appendAudioDataWithTimestamp(audioData, audioData.timestamp / 1000000.0);
	}

	prime(channels, sampleRate, timestamp) {
		channels = channels || 1;
		sampleRate = sampleRate || 48000;
		const planes = [];
		while(channels-- > 0)
			planes.push(new Float32Array());
		this.appendSamples(planes, sampleRate, timestamp);
	}

	flush() {
		if(!this._primed)
			return Promise.resolve();

		const myself = this;
		const rv = new Promise(function(resolve, reject) {
			myself._buffer.push({ command: "flush", resolve });
			myself._processBuffer();
		});
		return rv;
	}

	silence(timestamp) {
		if(!this._primed)
			this.prime();

		this._buffer.push({ command: "silence", timestamp });
		this._processBuffer();
	}

	reset() {
		const myself = this;
		const rv = new Promise(function(resolve, reject) {
			myself._buffer.push({ command: "reset", resolve });
			myself._processBuffer();
		});
		return rv;
	}

	get lastAppendedDuration() { return this._lastAppendedDuration; }

	get audioSourceNode() { return this._tcSourceNode; }

	_processBuffer() {
		if(this._pipelinePending)
			return;

		while(this._buffer.length)
		{
			const entry = this._buffer[0];
			if(this._checkPipelineForEntry(entry))
			{
				this._processEntry(entry);
				this._buffer.shift();
			}
			else
			{
				this._buildPipelineForEntry(entry);
				break;
			}
		}
	}

	_processEntry(entry) {
		switch(entry.command)
		{
		case "buffer":
			if(undefined == entry.timestamp)
				entry.timestamp = this._savedTimestamp;
			this._savedTimestamp = undefined;
			this._tcSourceNode.appendSamples(entry.planes, entry.timestamp);
			break;

		case "flush":
			this._tcSourceNode.flush().then(() => entry.resolve());
			break;
			
		case "silence":
			this._tcSourceNode.silence(entry.timestamp);
			break;

		case "reset":
			this._doReset(entry);
			this._primed = false;
			break;
		}
	}

	_doReset(entry) {
		if(this._context)
			this._context.close();
		this._context = null;
		this._tcSourceNode = null;
		this._gainNode = null;

		if(entry && entry.resolve)
			entry.resolve();
	}

	_buildPipeline(channels, sampleRate) {
		this._doReset();
		this._context = new AudioContext({ sampleRate });
		com_zenomt_TCAudioSourceNode.register(this._context).then(() => {
			this._tcSourceNode = new com_zenomt_TCAudioSourceNode(this._context, channels);
			this._tcSourceNode.onstatus = (event) => this._onMessage(event);
			this._tcSourceNode.bufferTime = this._bufferTime;

			this._gainNode = this._context.createGain();
			this._gainNode.gain.value = this._gain;

			this._tcSourceNode.connect(this._gainNode);
			this._gainNode.connect(this._context.destination);

			this._currentChannelCount = channels;

			this._pipelinePending = false;

			this._processBuffer();
		});
	}

	_buildPipelineForEntry(entry) {
		this._pipelinePending = true;
		if(this._tcSourceNode)
			this._tcSourceNode.flush().then(() => {
				this._savedTimestamp = this._tcSourceNode.currentTime;
				this._tcSourceNode.onstatus = undefined;
				this._buildPipeline(entry.planes.length, entry.sampleRate);
			});
		else
			this._buildPipeline(entry.planes.length, entry.sampleRate);
	}

	_checkPipelineForEntry(entry) {
		if("reset" == entry.command)
			return true;
		if(!this._tcSourceNode)
			return false;
		if("buffer" != entry.command)
			return true;
		if(entry.planes.length != this._tcSourceNode.channelCount)
			return false;
		if(entry.sampleRate != this._context.sampleRate)
			return false;
		return true;
	}

	_onMessage(event) {
		if(this.onstatus)
		{
			try { this.onstatus(event); }
			catch(e) { console.log("exception calling onstatus", this, event, e); }
		}
	}
};