// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

// global scope: currentFrame, currentTime, sampleRate

/*
port message (in) & buffer entry
	{
		command, // buffer, silence, clear, flush, setBufferTime
		timestamp?, // number
		insertionTime, // number, vs global currentTime
		planes?, // [[float32...]...]
		cumulativeFrames?, // number
		flushID?, // flush
		bufferTime? // setBufferTime
	}

port message (out)
	{
		totalFramesProcessed,
		timestamp, // (lastTimestamp + framesOutputSinceTimestamp / sampleRate)
		event?,
		info?, // any
	}
*/

registerProcessor('com_zenomt_TCAudioSourceNodeProcessor', class extends AudioWorkletProcessor {
	constructor(...args) {
		super(...args);
		this.port.onmessage = (event) => { this.onMessage(event) };

		this._state = "start"; // run, free, waiting, start
		this._totalFramesProcessed = 0;
		this._lastTimestamp = 0;
		this._framesOutputSinceTimestamp = 0;
		this._bufferTimeFrames = 1; // how much to accumulate before starting
		this._totalFramesAppended = 0;
		this._bufferLengthFrames = 0;
		this._bufferEntryOffset = 0;
		this._buffer = [];
	}

	shiftBuffer() {
		const entry = this._buffer.shift();
		if(entry.planes)
			this._bufferLengthFrames -= entry.planes[0].length;
		if(entry.cumulativeFrames)
			this._totalFramesProcessed = entry.cumulativeFrames;
		this._bufferEntryOffset = 0;
	}

	runSlice(offset, limit, output) {
		if(0 == this._buffer.length)
		{
			this._state = "waiting";
			this._bufferLengthFrames = 0;
			this.postMessage("NetStream.Buffer.Empty");
			return 0;
		}

		const entry = this._buffer[0];
		if(0 == this._bufferEntryOffset)
		{
			if(entry.timestamp != undefined)
			{
				this._lastTimestamp = entry.timestamp;
				this._framesOutputSinceTimestamp = 0;
			}
		}

		if("flush" == entry.command)
		{
			this.postFlush(entry);
			this.shiftBuffer();
			return -1;
		}

		if("silence" == entry.command)
		{
			this._state = "free";
			this.shiftBuffer();
			return -1;
		}

		if(("buffer" != entry.command) || (!entry.planes) || (entry.planes.length < 1))
		{
			this.shiftBuffer();
			return -1;
		}

		if(this._bufferEntryOffset >= entry.planes[0].length)
		{
			// we finished this buffer
			this.shiftBuffer();
			return -1;
		}

		const framesToCopy = Math.min(entry.planes[0].length - this._bufferEntryOffset, limit - offset);

		const numChannels = Math.min(output.length, entry.planes.length);
		for(let channel = 0; channel < numChannels; channel++)
			output[channel].set(entry.planes[channel].subarray(this._bufferEntryOffset, this._bufferEntryOffset + framesToCopy), offset);

		this._bufferEntryOffset += framesToCopy;
		this._totalFramesProcessed += framesToCopy;

		return framesToCopy;
	}

	processSlice(offset, limit, output) {
		switch(this._state)
		{
		case "run":
			return this.runSlice(offset, limit, output);

		case "free":
			if(0 == this._buffer.length)
				return limit - offset;
			this._state = "run";
			return -1; // restart

		case "waiting":
			if(this._bufferLengthFrames >= this._bufferTimeFrames)
			{
				this._state = "run";
				this.postMessage("NetStream.Buffer.Full");
				return -1; // restart
			}
			return 0;

		case "start":
			this._state = "waiting";
			this.postMessage("NetStream.Buffer.Empty");
			return -1; // restart
		}

		return 0;
	}

	postFlush(entry) {
		this.postMessage("NetStream.Buffer.Flush", { flushID: entry.flushID });
	}

	postMessage(event, info) {
		const message = {
			currentTime,
			totalFramesProcessed: this._totalFramesProcessed,
			timestamp: this._lastTimestamp + (this._framesOutputSinceTimestamp / sampleRate)
		};
		if(event)
			message.event = event;
		if(info)
			message.info = info;
		this.port.postMessage(message);
	}

	process(inputs, outputs, parameters) {
		const output = outputs[0];
		const limit = output[0].length;
		var offset = 0;
		while(offset < limit)
		{
			const rv = this.processSlice(offset, limit, output);
			if(0 == rv)
				break;
			if(rv < 0) // restart
				continue;
			offset += rv;
			this._framesOutputSinceTimestamp += rv;
		}

		if("waiting" != this._state)
			this.postMessage();

		return true;
	}

	doClearBuffer() {
		while(this._buffer.length)
		{
			var entry = this._buffer[0];

			if("flush" == entry.command)
				this.postFlush(entry);

			this.shiftBuffer();
		}

		this._bufferLengthFrames = 0;
		this._totalFramesProcessed = this._totalFramesAppended;

		// anything else TODO?
	}

	appendBuffer(entry) {
		this._buffer.push(entry);
		if(entry.planes && entry.planes.length)
		{
			this._bufferLengthFrames += entry.planes[0].length;
			this._totalFramesAppended += entry.planes[0].length;
		}
		entry.cumulativeFrames = this._totalFramesAppended;
	}

	onMessage(event) {
		if(event && event.data)
		{
			const data = event.data;
			switch(data.command)
			{
			case "clear": // is this needed?
				this.doClearBuffer();
				break;

			case "silence":
			case "flush":
				if(("waiting" == this._state) || ("start" == this._state))
				{
					this._state = "run";
					this.postMessage("NetStream.Buffer.Full");
				}
				// fallthrough
			case "buffer":
				this.appendBuffer(data);
				break;

			case "setBufferTime":
				this._bufferTimeFrames = Math.max(data.bufferTime * sampleRate, 1);
				break;
			}
		}
	}
});
