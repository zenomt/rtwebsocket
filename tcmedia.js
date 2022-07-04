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
		this._seenAudio = true;

		if(header.silence)
		{
			this._resyncAudio().then(() => this.audioController.silence(header.timestamp / 1000.0));
			return;
		}

		const payload = message.subarray(header.payloadOffset);

		if((message[header.consumed] != this._lastAudioType) || (com_zenomt_TCMessage.TC_AUDIO_AACPACKET_AUDIO_SPECIFIC_CONFIG == header.aacPacketType))
		{
			var config;
			switch(header.codec)
			{
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_AAC:
				if((com_zenomt_TCMessage.TC_AUDIO_AACPACKET_AUDIO_SPECIFIC_CONFIG == header.aacPacketType) && payload.length)
				{
					config = { codec:"mp4a.40.2", description:payload };
					header.numberOfChannels = (payload[1] & 0x78) >> 3; // shouldn't be needed for mp4a.40.2, but Chrome needs it to match.
				}
				else
					return;
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_MP3:
				config = { codec:"mp3" };
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_G711_MU_LAW:
				config = { codec:"ulaw" };
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_G711_A_LAW:
				config = { codec:"alaw" };
				break;
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_DEVICE_SPECIFIC: // Opus? for now.
				config = { codec:"opus" }
				break;
			default:
				this._lastAudioType = -1;
				return;
			}

			config.numberOfChannels = header.numberOfChannels;
			config.sampleRate = header.sampleRate;

			this._lastAudioType = message[header.consumed];

			try { this._audioDecoder.configure(config); }
			catch(e) {
				console.log("TCMediaDecoder error audioDecoder.configure()", config);
				this._onAudioDecoderError(e);
				return;
			}

			this._audioError = false;

			if(header.isAAC)
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
	}

	_onVideoMessage(header, message) {
		if(header.isAVC)
		{
			let payload = message.subarray(header.payloadOffset);

			if(com_zenomt_TCMessage.TC_VIDEO_AVCPACKET_AVCC == header.avcPacketType)
			{
				if(payload.length < 2)
				{
					this._videoDecoder.reset();
					this._seenVideoKeyframe = false;
					return;
				}

				let config = {
					codec: "avc1.64081f",
					description: payload
				};

				try { this._videoDecoder.configure(config); }
				catch(e) {
					console.log("videoDecoder.configure()", e);
					this._videoDecoder.reset();
				}
				this._seenVideoKeyframe = false;
			}
			else if(("configured" == this._videoDecoder.state) && (com_zenomt_TCMessage.TC_VIDEO_AVCPACKET_NALU == header.avcPacketType))
			{
				if(com_zenomt_TCMessage.TC_VIDEO_FRAMETYPE_COMMAND == header.frametype)
					return;

				const type = (com_zenomt_TCMessage.TC_VIDEO_FRAMETYPE_IDR == header.frametype) ? "key" : "delta";
				if("key" == type)
					this._seenVideoKeyframe = true;
				if(!this._seenVideoKeyframe)
					return;

				if((!this._seenAudio) && (!this._sendingSilence) && (this._videoFrames.length > 2))
				{
					// get video moving. if audio frames come along, they'll override the silence.
					this._resyncAudio().then(() => this.audioController.silence(header.timestamp / 1000.0));
					this._sendingSilence = true;
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
}
