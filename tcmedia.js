// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

class com_zenomt_TCMediaDecoder {
	constructor(netStream) {
		this.audioController = new com_zenomt_SimpleAudioController();
		this._videoFrames = [];
		this._audioFrameCount = 0;
		this._audioFrameSkipThresh = 12;
		this._lastAudioTimestamp = -Infinity;
		this._animationFrameRequested = false;
		this._lastAudioType = -1;

		this._audioDecoder = new AudioDecoder({ output:this._onAudioDecoderOutput.bind(this), error:this._onAudioDecoderError.bind(this) });
		this._videoDecoder = new VideoDecoder({ output:this._onVideoDecoderOutput.bind(this), error:this._onVideoDecoderError.bind(this) });

		netStream.onaudio = this._onAudioMessage.bind(this);
		netStream.onvideo = this._onVideoMessage.bind(this);
		// TODO data, need to rework netStream data

		this.ondrawframe = function(frame) {}
	}

	close() {
		this._audioDecoder.close(); this._audioDecoder = null;
		this._videoDecoder.close(); this._videoDecoder = null;
		this._flushVideoFrames();
		this.audioController.reset();
	}

	// ---

	_onAudioDecoderOutput(output) {
		this.audioController.appendAudioData(output);
		output.close();
	}

	_onAudioDecoderError(e) { console.log("audio decoder error", e); }

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

	_onVideoDecoderError() { console.log("video decoder error", e); }

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
		if(header.silence)
		{
			this.audioController.silence(header.timestamp / 1000.0);
			return;
		}

		const payload = message.subarray(header.payloadOffset);

		if((message[0] != this._lastAudioType) || (com_zenomt_TCMessage.TC_AUDIO_AACPACKET_AUDIO_SPECIFIC_CONFIG == header.aacPacketType))
		{
			var config;
			switch(header.codec)
			{
			case com_zenomt_TCMessage.TC_AUDIO_CODEC_AAC:
				if(com_zenomt_TCMessage.TC_AUDIO_AACPACKET_AUDIO_SPECIFIC_CONFIG == header.aacPacketType)
				{
					config = { codec:"mp4a.40.2", description:payload };
					header.numberOfChannels = 2;
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

			this._lastAudioType = message[0];

			try { this._audioDecoder.configure(config); }
			catch(e) {
				console.log("TCMediaDecoder error audioDecoder.configure(), setting silence", e, config);
				this.audioController.silence(header.timestamp / 1000.0);
				this._audioDecoder.close();
				this._audioDecoder = new AudioDecoder({ output:this._onAudioDecoderOutput.bind(this), error:this._onAudioDecoderError.bind(this) });
				return;
			}

			if(header.isAAC)
				return; // this was a config message
		}

		if("configured" != this._audioDecoder.state)
			return;

		const bufferLength = this.audioController.bufferLength;
		const minimumBufferLength = this.audioController.audioSourceNode?.minimumBufferLength || 0;

		if(this.audioController.audioSourceNode?.isOverbuffered() && (this._audioFrameCount >= this._audioFrameSkipThresh))
		{
			this._audioFrameCount = 0;
			console.log("dropping encoded audio frame because delay is high: " + this.audioController.bufferLength + " min: " + minimumBufferLength, header.timestamp);
			return;
		}

		if( (header.timestamp > this._lastAudioTimestamp + this.audioController.lastAppendedDuration * 1.5 * 1000)
		 || (header.timestamp < this._lastAudioTimestamp)
		)
			this._audioDecoder.flush();
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
			}
			else if(("configured" == this._videoDecoder.state) && (com_zenomt_TCMessage.TC_VIDEO_AVCPACKET_NALU == header.avcPacketType))
			{
				if(com_zenomt_TCMessage.TC_VIDEO_FRAMETYPE_COMMAND == header.frametype)
					return;
				this._videoDecoder.decode(new EncodedVideoChunk({
					type: (com_zenomt_TCMessage.TC_VIDEO_FRAMETYPE_IDR == header.frametype) ? "key" : "delta",
					timestamp: ((header.presentationTime < 0) ? 0 : header.presentationTime) * 1000, // ms -> µs
					data: payload
				}));
			}
		}
	}
}
