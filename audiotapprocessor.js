// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

registerProcessor('com_zenomt_AudioTapNodeProcessor', class extends AudioWorkletProcessor {
	constructor(options, ...args) {
		super(options, ...args);
		this._offset = 0;
		this._planes = [];
		this._bufferTimestamp = 0;

		const samplesPerBuffer = Number(options.processorOptions.samplesPerBuffer) || 1024;
		this._samplesPerPost = 128 * Math.floor((samplesPerBuffer + 127) / 128);
	}

	process(inputs, outputs, parameters) {
		const input = inputs[0];
		const output = outputs[0];

		if(0 == this._offset)
			this._bufferTimestamp = currentTime;

		for(var ch = 0; ch < inputs.length; ch++)
		{
			if(0 == this._offset)
				this._planes.push(new Float32Array(this._samplesPerPost));

			output[ch].set(input[ch]);
			this._planes[ch].set(input[ch], this._offset);
		}

		this._offset += input[0].length;

		if(this._offset >= this._samplesPerPost)
		{
			this.port.postMessage({command:"samples", currentTime:this._bufferTimestamp, sampleRate, planes:this._planes});
			this._offset = 0;
			this._planes = [];
		}

		return true;
	}
});
