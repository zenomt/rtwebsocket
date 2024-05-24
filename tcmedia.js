// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

class com_zenomt_TCMediaDecoder {
	constructor(netStream) {
		this.audioController = new com_zenomt_SimpleAudioController();
		this._netStream = netStream;
		this._videoFrames = [];
		this._audioFrameCount = 0;
		this.audioFrameSkipThresh = 12;
		this._lastAudioTimestamp = -Infinity;
		this._animationFrameRequested = false;
		this._lastAudioType = -1;
		this._lastAudioCodec = -1;
		this._configuredVideoType = -1;
		this._configuredVideoDescription = undefined;
		this._audioIsResyncing = false;
		this._audioNeedsResync = false;
		this._seenAudio = false;
		this._sendingSilence = false;
		this._audioError = false;
		this._seenVideoKeyframe = false;

		this._makeAudioDecoder();
		this._makeVideoDecoder();

		netStream.onaudio = this._onAudioMessage.bind(this);
		netStream.onvideo = this._onVideoMessage.bind(this);
		// TODO data, need to rework netStream data

		this._boundNetStatusCallback = this._onNetStatus.bind(this);
		netStream.addEventListener("netStatus", this._boundNetStatusCallback);

		this.ondrawframe = function(frame) {}
	}

	drawFramesToCanvas(canvas) {
		this.ondrawframe = (frame) => com_zenomt_TCMediaDecoder.displayFrameOnCanvas(frame, canvas);
	}

	close() {
		this._audioDecoder.close(); this._audioDecoder = null;
		this._videoDecoder.close(); this._videoDecoder = null;
		this._flushVideoFrames();
		this.audioController.reset();

		this._netStream.removeEventListener("netStatus", this._boundNetStatusCallback);
		this._boundNetStatusCallback = null;

		this._netStream.onaudio = null;
		this._netStream.onvideo = null;
		this._netStream = null;
	}

	async audioFlush() {
		if("configured" == this._audioDecoder?.state)
			await this._audioDecoder.flush();
		await this.audioController.flush();
	}

	async videoFlush() {
		this._seenVideoKeyframe = false;
		if("configured" == this._videoDecoder?.state)
			await this._videoDecoder.flush();
	}

	static displayFrameOnCanvas(frame, canvas) {
		const frameAspect = frame.displayWidth / frame.displayHeight;
		const canvasAspect = canvas.width / canvas.height;

		var dx, dy;
		var dWidth, dHeight;

		if(frameAspect >= canvasAspect) // frame is wider than canvas
		{
			const adjustFactor = frame.displayWidth / canvas.width;
			dWidth = canvas.width;
			dHeight = frame.displayHeight / adjustFactor;
			dx = 0;
			dy = (canvas.height - dHeight) / 2;
		}
		else
		{
			const adjustFactor = frame.displayHeight / canvas.height;
			dHeight = canvas.height;
			dWidth = frame.displayWidth / adjustFactor;
			dx = (canvas.width - dWidth) / 2;
			dy = 0;
		}

		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(frame, dx, dy, dWidth, dHeight);
	}

	// ---

	_makeVideoDecoder() {
		this._videoDecoder = new VideoDecoder({ output:this._onVideoDecoderOutput.bind(this), error:this._onVideoDecoderError.bind(this) });
	}

	_makeAudioDecoder() {
		this._audioDecoder = new AudioDecoder({ output:this._onAudioDecoderOutput.bind(this), error:this._onAudioDecoderError.bind(this) });
	}

	_onNetStatus(event) {
		switch(event.detail.code)
		{
		case "NetStream.Play.UnpublishNotify":
			this.audioFlush();
			// not videoFlush because video frames aren't guaranteed to all be delivered yet
			break;
		case "NetStream.Play.PublishNotify":
			this._seenAudio = false;
			this._sendingSilence = false;
			break;
		}
	}

	_onAudioDecoderOutput(output) {
		this.audioController.appendAudioData(output);
		output.close();
		this._sendingSilence = false;
	}

	_onAudioDecoderError(e) {
		console.log("audio decoder error", e);
		this._audioError = true;
		if("closed" != this._audioDecoder.state)
			this._audioDecoder.close();
		this._makeAudioDecoder();
	}

	_onVideoDecoderOutput(output) {
		if(this._videoFrames.length && (output.timestamp < this._videoFrames[this._videoFrames.length - 1].timestamp))
		{
			console.log("dropping " + this._videoFrames.length + " video frames because timestamps reset");
			this._flushVideoFrames();
		}
		this._videoFrames.push(output);

		if(!this._animationFrameRequested)
		{
			requestAnimationFrame(this._displayVideoFrame.bind(this));
			this._animationFrameRequested = true;
		}
	}

	_onVideoDecoderError(e) {
		console.log("video decoder error", e);
		if("closed" != this._videoDecoder.state)
			this._videoDecoder.close();
		this._makeVideoDecoder();
	}

	_flushVideoFrames() {
		var each;
		while((each = this._videoFrames.shift()))
			each.close();
	}

	_displayVideoFrame() {
		if(0 == this._videoFrames.length)
		{
			this._animationFrameRequested = false;
			return;
		}

		const now = this.audioController.currentTime;

		var frame;
		while(this._videoFrames.length)
		{
			const each = this._videoFrames[0];
			if((each.timestamp / 1000000.0) <= now)
			{
				if(frame)
					frame.close();

				frame = each;
				this._videoFrames.shift();
			}
			else
				break;
		}

		if((!frame) && (!this.audioController.clockRunning))
			frame = this._videoFrames.shift();

		if(frame)
		{
			if(this.ondrawframe)
			{
				try { this.ondrawframe(frame); }
				catch(e) { console.log("exception calling ondrawframe", this, frame, e); }
			}
			frame.close();
		}

		requestAnimationFrame(this._displayVideoFrame.bind(this));
	}

	_onAudioMessage(header, message) {
		if(header.silence)
		{
			this._seenAudio = false;
			this._resyncAudio().then(() => this.audioController.silence(header.timestamp / 1000.0 - this.audioController.bufferTime));
			this._sendingSilence = true;
			return;
		}

		const payload = message.subarray(header.payloadOffset);

		if( ((!header.enhanced) && (message[header.consumed] != this._lastAudioType))
		 || (header.codec != this._lastAudioCodec)
		 || header.isConfiguration
		)
		{
			var config;

			switch(header.codec)
			{
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_AAC:
			case com_zenomt_TCMessage.TC_AUDIO_ENH_CODEC_AAC:
				if(header.isConfiguration && payload.length)
					config = { codec:"mp4a.40.2", description:payload };
				else
					return;
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_MP3:
			case com_zenomt_TCMessage.TC_AUDIO_ENH_CODEC_MP3: // TODO: do we need accurate sample rate & channels?
				config = { codec:"mp3" };
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_G711_MU_LAW:
				config = { codec:"ulaw" };
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_G711_A_LAW:
				config = { codec:"alaw" };
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_DEVICE_SPECIFIC: // Opus? for now.
			case com_zenomt_TCMessage.TC_AUDIO_ENH_CODEC_OPUS:
				config = { codec:"opus", sampleRate:48000 }
				if(header.isConfiguration && payload.length)
					config.description = payload;
				break;
			case com_zenomt_TCMessage.TC_AUDIO_ENH_CODEC_FLAC:
				if(header.isConfiguration && payload.length)
					config = { codec:"flac", description:payload };
				else
					return;
				break;
			default:
				this._lastAudioType = -1;
				this._lastAudioCodec = -1;
				return;
			}

			config.numberOfChannels = config.numberOfChannels ?? header.numberOfChannels ?? 2;
			config.sampleRate = config.sampleRate ?? header.sampleRate ?? 44100;

			this._lastAudioType = message[header.consumed];
			this._lastAudioCodec = header.codec;

			try { this._audioDecoder.configure(config); }
			catch(e) {
				console.log("TCMediaDecoder error audioDecoder.configure()", config);
				this._onAudioDecoderError(e);
				return;
			}

			this._audioError = false;

			if(header.isConfiguration)
				return; // this was a config message
		}

		if(this._audioError)
			this.audioController.silence(header.timestamp / 1000.0);

		if("configured" != this._audioDecoder.state)
			return;

		if(this.audioController.audioSourceNode?.isOverbuffered() && (this._audioFrameCount >= this.audioFrameSkipThresh))
		{
			const bufferLength = this.audioController.bufferLength;
			const minimumBufferLength = this.audioController.audioSourceNode?.minimumBufferLength || 0;
			this._audioFrameCount = 0;
			console.log("dropping encoded audio frame because delay is high: " + this.audioController.bufferLength + " min: " + minimumBufferLength, header.timestamp);
			return;
		}

		if( (header.timestamp > this._lastAudioTimestamp + this.audioController.lastAppendedDuration * 1.5 * 1000)
		 || (header.timestamp < this._lastAudioTimestamp)
		)
			this._resyncAudio();
		this._lastAudioTimestamp = header.timestamp;

		const encodedChunk = new EncodedAudioChunk({
			type: "key",
			timestamp: header.timestamp * 1000, // ms -> µs
			data: payload
		});
		this._audioDecoder.decode(encodedChunk);
		this._audioFrameCount++;
		this._seenAudio = true;
	}

	_onVideoMessage(header, message) {
		const payload = message.subarray(header.payloadOffset);

		if(header.isConfiguration)
		{
			var config = { codec: header.codecParameterString };

			this._seenVideoKeyframe = false;

			if( (com_zenomt_TCMessage.TC_VIDEO_ENH_CODEC_HEVC == header.codec)
			 || (com_zenomt_TCMessage.TC_VIDEO_CODEC_AVC == header.codec)
			 || (com_zenomt_TCMessage.TC_VIDEO_ENH_CODEC_AVC == header.codec)
			)
				config.description = payload;

			if(!config.codec)
				return;

			if( ("configured" == this._videoDecoder?.state)
			 && (this._configuredVideoType == header.codec)
			 && (this._compareBytes(this._configuredVideoDescription, config.description))
			)
				return; // duplicate config, skip

			try {
				console.log("configure", config);
				this._videoDecoder?.close();
				this._makeVideoDecoder();
				this._videoDecoder.configure(config);
				this._configuredVideoType = header.codec;
				this._configuredVideoDescription = config.description;
			}
			catch(e) {
				console.log("videoDecoder.configure()", config, e);
				this._configuredVideoType = -1;
				this._videoDecoder.reset();
			}
		}

		if(header.codec != this._configuredVideoType)
			return;

		if(("configured" == this._videoDecoder.state) && header.isCodedFrame)
		{
			const type = (com_zenomt_TCMessage.TC_VIDEO_FRAMETYPE_IDR == header.frametype) ? "key" : "delta";
			if("key" == type)
				this._seenVideoKeyframe = true;
			if(!this._seenVideoKeyframe)
				return;

			if(!this._seenAudio)
			{
				// get video moving. if audio frames come along, they'll override the silence.
				const thisFrameTime = header.timestamp / 1000.0;

				if(!this._sendingSilence)
				{
					this._resyncAudio().then(() => this.audioController.silence(thisFrameTime - this.audioController.bufferTime));
					this._sendingSilence = true;
				}
				else
				{
					// TODO real video-only jitter buffering

					const now = this.audioController.currentTime;

					if( (thisFrameTime - now > this.audioController.bufferTime + 0.050)
					 || (thisFrameTime < now)
					)
						this.audioController.silence(thisFrameTime - this.audioController.bufferTime);
				}
			}

			try {
				this._videoDecoder.decode(new EncodedVideoChunk({
					type,
					timestamp: ((header.presentationTime < 0) ? 0 : header.presentationTime) * 1000, // ms -> µs
					data: payload
				}));
			}
			catch(e) { this._onVideoDecoderError(e); }
		}
		else if(("configured" == this._videoDecoder.state) && header.isSequenceEnd)
		{
			try { this._videoDecoder.flush(); }
			catch(e) { this._onVideoDecoderError(e); }
		}
	}

	async _resyncAudio() {
		if(this._audioIsResyncing)
			this._audioNeedsResync = true;
		else
		{
			this._audioNeedsResync = false;
			this._audioIsResyncing = true;
			if("configured" == this._audioDecoder?.state)
				await this._audioDecoder.flush();
			this._audioIsResyncing = false;
			if(this._audioNeedsResync)
				this._resyncAudio();
		}
	}

	_compareBytes(l, r) {
		if(l == r)
			return true;
		if((!l) || (!r))
			return false;
		if(l.length != r.length)
			return false;
		return l.every((val, i) => val == r[i]);
	}
}
