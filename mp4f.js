// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

class com_zenomt_ByteVector {
	constructor(initialLength, initialCapacity) {
		initialLength = initialLength || 0;
		initialCapacity = Math.max(initialLength, initialCapacity || 256);

		this.buffer = new Uint8Array(initialCapacity);
		this._length = initialLength;
	}

	get capacity() { return this.buffer.byteLength; }

	get byteLength() { return this._length; }

	get length() { return this._length; }
	set length(v) {
		if(v > this.capacity)
		{
			var old = this.buffer;
			this.buffer = new Uint8Array(Math.max(v, old.byteLength * 2));
			this.buffer.set(old.subarray(0, this._length));
		}
		else if(v > this._length)
			this.buffer.fill(0, this._length, v);

		this._length = v;
	}

	snapshot() { return this.buffer.subarray(0, this._length); }

	at(pos) {
		if(pos >= this._length)
			return 0;
		return this.buffer[pos];
	}

	setValueAt(val, pos) {
		if(pos >= this.length)
			this.length = pos + 1;
		if("string" == typeof(val))
			val = val.charCodeAt(0);
		this.buffer[pos] = val & 0xff;
	}

	shift(num) {
		if(undefined == num)
			num = 1;
		if(num < 1)
			return;
		if(num >= this._length)
			this._length = 0;
		else if(num < this._length)
		{
			this.buffer.set(this.buffer.subarray(num, this._length), 0);
			this._length -= num;
		}
	}

	set(src, pos) {
		var len = src.byteLength;
		pos = pos || 0;
		if(src.snapshot)
			src = src.snapshot();
		if(pos + len > this.length)
			this.length = pos + len;
		this.buffer.set(src, pos);
	}

	setValuesAt(values, pos) {
		for(var i = 0; i < values.length; i++)
			this.setValueAt(values[i], pos + i);
	}

	append(src) { this.set(src, this.length); }

	appendValues(values) { this.setValuesAt(values, this.length); }

	setU16At(val, pos) {
		this.setValuesAt([val >> 8, val], pos);
	}

	setU32At(val, pos) {
		this.setValuesAt([val >> 24, val >> 16, val >>  8, val], pos);
	}

	setU64At(val, pos) {
		// we can't use shifting for unsigned >31 bits
		this.setValuesAt([
			val / 0x100000000000000,
			val / 0x1000000000000,
			val / 0x10000000000,
			val / 0x100000000,
			val / 0x1000000,
			val / 0x10000,
			val / 0x100,
			val
		], pos);
	}

	expGolomb(bitOffset) { return new com_zenomt_ExpGolomb(this, bitOffset); }
}

class com_zenomt_ExpGolomb {
	constructor(bytes, bit) {
		this.buffer = bytes;
		this.bit = bit || 0;
	}

	at(bit) {
		const offset = Math.floor(bit / 8);
		if(offset > this.buffer.length)
			throw new RangeError("buffer exceeded");
		const pos = 7 - (bit - (offset * 8));
		return (this.buffer.at(offset) & (1 << pos)) ? 1 : 0;
	}

	nextBit() { return this.at(this.bit++); }

	nextValue() {
		var exp = 0;
		var rv = 0;
		var moreBits = 0;

		while(0 == this.nextBit())
			moreBits++;
		exp = (1 << moreBits) - 1;

		while(moreBits--)
			rv = (rv * 2) + this.nextBit();

		return exp + rv;
	}

	nextSignedValue() {
		const val = this.nextValue();
		if(val & 1)
			return (val + 1) / 2;
		else
			return (val / -2) || 0;
	}
}

class com_zenomt_MP4Box {
	constructor(type, parent, version, flags) {
		if(4 != type?.length)
			throw new TypeError("type must be exactly 4 bytes");
		this.parent = parent.sync ? parent : null;
		this.buffer = this.parent ? parent.buffer : (parent || new com_zenomt_ByteVector());
		this.start = this.buffer.length;
		this.appendU32Values([0, type]);
		flags = flags || 0;
		if(version >= 0)
			this.appendValues([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
		this.sync();
	}

	sync() {
		this.end = this.buffer.length;
		this.buffer.setU32At(this.end - this.start, this.start);
		this.parent?.sync();
	}

	close() {
		this.sync();
		this.parent = this.buffer = null;
	}

	append(src) { this.buffer.append(src); }
	appendValues(values) { this.buffer.appendValues(values); }
	appendU8(val) { this.buffer.setValueAt(val, this.buffer.length); }
	appendU16(val) { this.buffer.setU16At(val, this.buffer.length); }
	appendU32(val) { this.buffer.setU32At(val, this.buffer.length); }
	appendU64(val) { this.buffer.setU64At(val, this.buffer.length); }

	appendU32Values(values) {
		for(var i = 0; i < values.length; i++)
		{
			const each = values[i];
			if(4 == each.length)
				this.appendValues(each);
			else
				this.appendU32(each);
		}
	}

	child(type, version, flags) {
		if(!this.buffer)
			throw new ReferenceError("closed");
		return new this.constructor(type, this, version, flags);
	}

	snapshot() { return this.buffer.buffer.subarray(this.start, this.end); }
}

class com_zenomt_MP4F {
	videoTrackID = 1;
	audioTrackID = 2;
	sampleRate = 0;
	samplesPerAudioFrame = 0;

	_nextSegmentNumber = 1;

	static getVideoDimensionsFromSPS(sps_nal) {
		const profile_idc = sps_nal.at(1);
		const level_idc = sps_nal.at(3);
		const eg = new com_zenomt_ExpGolomb(sps_nal, 4*8); // offset of seq_parameter_set_id

		let chromaArrayType = 0;
		eg.nextValue(); // seq_parameter_set_id
		if([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile_idc) >= 0)
		{
			let chroma_format_idc = eg.nextValue();
			chromaArrayType = chroma_format_idc;
			if(3 == chroma_format_idc)
			{
				if(eg.nextBit()) // separate_colour_plane_flag [sic]
					chromaArrayType = 0;
			}
			eg.nextValue(); // bit_depth_luma_minus8
			eg.nextValue(); // bit_depth_chroma_minus8
			eg.nextBit(); // qpprime_y_zero_transform_bypass_flag
			if(eg.nextBit()) // seq_scaling_matrix_present_flag better not be set
			{
				console.log("seq_scaling_matrix_present_flag set! better implement scaling_list syntax correctly to skip over it!");
				eg.bit += (3 != chroma_format_idc) ? 8 : 12;
			}
		}
		eg.nextValue(); // log2_max_frame_num_minus4
		const pic_order_cnt_type = eg.nextValue();
		if(0 == pic_order_cnt_type)
			eg.nextValue(); // log2_max_pic_order_cnt_lsb_minus4
		else if(1 == pic_order_cnt_type)
		{
			eg.nextBit(); // delta_pic_order_always_zero_flag
			eg.nextSignedValue(); // offset_for_non_ref_pic
			eg.nextSignedValue(); // offset_for_top_to_bottom_field
			const num_ref_frames_in_pic_order_cnt_cycle = eg.nextValue();
			for(var i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++)
				eg.nextSignedValue(); // offset_for_ref_frame[i]
		}
		eg.nextValue(); // max_num_ref_frames
		eg.nextBit(); // gaps_in_frame_num_value_allowed_flag

		const pic_width_in_mbs_minus1 = eg.nextValue();
		const pic_height_in_map_units_minus1 = eg.nextValue();
		var width = (pic_width_in_mbs_minus1 + 1) * 16;
		var height = (pic_height_in_map_units_minus1 + 1);
		const frame_mbs_only_flag = eg.nextBit();
		height *= frame_mbs_only_flag ? 16 : 8;
		if(!frame_mbs_only_flag)
			eg.nextBit(); // mb_adaptive_frame_field_flag
		eg.nextBit(); // direct_8x8_inference_flag
		const frame_cropping_flag = eg.nextBit();
		if(frame_cropping_flag)
		{
			const frame_crop_left_offset = eg.nextValue();
			const frame_crop_right_offset = eg.nextValue();
			const frame_crop_top_offset = eg.nextValue();
			const frame_crop_bottom_offset = eg.nextValue();

			var subWidthC = 1;
			var subHeightC = 1;
			if(1 == chromaArrayType)
			{
				subWidthC = 2;
				subHeightC = 2;
			}
			else if(2 == chromaArrayType)
				subWidthC = 2;

			var cropUnitX;
			var cropUnitY;
			if(0 == chromaArrayType)
			{
				cropUnitX = 1;
				cropUnitY = 2 - frame_mbs_only_flag;
			}
			else
			{
				cropUnitX = subWidthC;
				cropUnitY = subHeightC * (2 - frame_mbs_only_flag);
			}

			width -= (frame_crop_left_offset + frame_crop_right_offset) * cropUnitX;
			height -= (frame_crop_top_offset + frame_crop_bottom_offset) * cropUnitY;
		}

		return { width, height, profile_idc, level_idc };
	}

	static getVideoDimensionsFromAVCC(avcc) {
		const sps_length = (avcc.at(6) * 256) + avcc.at(7);
		const sps = avcc.subarray(8, 8 + sps_length);
		return this.getVideoDimensionsFromSPS(sps);
	}

	static getAudioDimensionsFromAacAudioSpecificConfig(aacAudioSpecificConfig) {
		const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0];
		const sampleRateIndex = ((aacAudioSpecificConfig.at(0) & 0x7) << 1) + ((aacAudioSpecificConfig.at(1) >> 7) & 0x1);
		const channelConfig = (aacAudioSpecificConfig.at(1) & 0x78) >> 3;
		const channels = (7 == channelConfig) ? 8 : channelConfig;
		return { channelConfig, sampleRateIndex, channels, sampleRate:sampleRates[sampleRateIndex] };
	}

	makeInitSegment(config) {
		const { avcc, aacAudioSpecificConfig } = config;
		const dst = new com_zenomt_ByteVector();

		const ftyp = new com_zenomt_MP4Box("ftyp", dst);
		ftyp.appendU32Values(["iso6", 0, "isom", "iso6", "msdh"]);
		ftyp.close();

		const moov = new com_zenomt_MP4Box("moov", dst);

		const mvhd = moov.child("mvhd", 0, 0);
		mvhd.appendU32Values([
			0, 0, 90000, 0xffffffff, 0x10000, 0x01000000, 0, 0, // create, mod, tscale, dur, rate, vol, rsv
			0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000, // unity matrix
			0, 0, 0, 0, 0, 0, // reserved(6 U32)
			0xffffffff // next trackID
		]);
		mvhd.close();

		if(avcc)
			this._addTrak(moov, this.videoTrackID, { avcc });
		if(aacAudioSpecificConfig)
			this._addTrak(moov, this.audioTrackID, { aacAudioSpecificConfig });

		const mvex = moov.child("mvex");
		if(avcc)
			this._addTrex(mvex, this.videoTrackID);
		if(aacAudioSpecificConfig)
			this._addTrex(mvex, this.audioTrackID);

		return dst.snapshot();
	}

	makeFrameSegment(trackID, dts, pts, duration, data) {
		dts = dts * 90000;
		pts = pts * 90000;
		duration = duration * 90000;

		const dst = new com_zenomt_ByteVector();

		const moof = new com_zenomt_MP4Box("moof", dst);

		const mfhd = moof.child("mfhd", 0, 0);
		mfhd.appendU32(this._nextSegmentNumber++);
		mfhd.close();

		const traf = moof.child("traf");

		const tfhd = traf.child("tfhd", 0, 0x20000);
		tfhd.appendU32(trackID);
		tfhd.close();

		const tfdt = traf.child("tfdt", 1, 0);
		tfdt.appendU64(dts);
		tfdt.close();

		const trun = traf.child("trun", 1, 0xb01); // signed offsets, comp time, size, duration, offset present
		trun.appendU32(1); // one access unit
		const data_offset_offset = dst.length;
		trun.appendU32(0); // will patch when we make the mdat
		trun.appendU32(duration);
		trun.appendU32(data.length);
		var compositionTimeOffset = Math.max(-0x80000000, Math.min(0x7ffffff, pts - dts));
		if(compositionTimeOffset < 0)
			compositionTimeOffset = 0xffffffff + (compositionTimeOffset + 1);
		trun.appendU32(compositionTimeOffset);
		trun.sync();

		const mdat = new com_zenomt_MP4Box("mdat", dst);
		dst.setU32At(dst.length - moof.start, data_offset_offset); // patch trun
		mdat.append(data);
		mdat.sync();

		return dst.snapshot();
	}

	// ---

	_addTrak(parent, trackID, config) {
		const videoDimensions = config.avcc ? this.constructor.getVideoDimensionsFromAVCC(config.avcc) : { width:0, height:0 };

		const trak = parent.child("trak");

		const tkhd = trak.child("tkhd", 0, 7);
		tkhd.appendU32Values([0, 0, trackID, 0, 0xffffffff, 0, 0, 0, 0x01000000, 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]);
		tkhd.appendU32Values([videoDimensions.width * 65536, videoDimensions.height * 65536]);
		tkhd.close();

		const mdia = trak.child("mdia");

		const mdhd = mdia.child("mdhd", 0, 0);
		mdhd.appendU32Values([0, 0, 90000, 0xffffffff, 0x55c40000]); // creat, mod, tscale, dur, lang | 0
		mdhd.close();

		const hdlr = mdia.child("hdlr", 0, 0);
		if(config.aacAudioSpecificConfig)
		{
			hdlr.appendU32Values([0, "soun", 0, 0, 0]);
			hdlr.appendValues("audio track");
			hdlr.appendU8(0);
		}
		else if(config.avcc)
		{
			hdlr.appendU32Values([0, "vide", 0, 0, 0]);
			hdlr.appendValues("video track");
			hdlr.appendU8(0);
		}
		hdlr.close();

		const minf = mdia.child("minf");

		if(config.aacAudioSpecificConfig)
		{
			const smhd = minf.child("smhd", 0, 0);
			smhd.appendU32(0); // balance, reserved
			smhd.close();
		}
		else if(config.avcc)
		{
			const vmhd = minf.child("vmhd", 0, 1);
			vmhd.appendU32Values([0, 0]); // mode:copy, opcolor:(0,0,0)
			vmhd.close();
		}

		const dinf = minf.child("dinf");
		const dref = dinf.child("dref", 0, 0);
		dref.appendU32(1);
		dref.child("url ", 0, 1);

		const stbl = minf.child("stbl");

		const stts = stbl.child("stts", 0, 0);
		stts.appendU32(0);
		stts.close();

		const ctts = stbl.child("ctts", 0, 0);
		ctts.appendU32(0);
		ctts.close();

		const stsc = stbl.child("stsc", 0, 0);
		stsc.appendU32(0);
		stsc.close();

		const stsz = stbl.child("stsz", 0, 0);
		stsz.appendU32Values([0, 0]);
		stsz.close();

		const stco = stbl.child("stco", 0, 0);
		stco.appendU32(0);
		stco.close();

		const stsd = stbl.child("stsd", 0, 0);
		stsd.appendU32(1); // one entry
		if(config.aacAudioSpecificConfig)
		{
			const audioDimensions = this.constructor.getAudioDimensionsFromAacAudioSpecificConfig(config.aacAudioSpecificConfig);
			this.sampleRate = audioDimensions.sampleRate;
			this.samplesPerAudioFrame = 1024;

			const mp4a = stsd.child("mp4a");
			mp4a.appendU64(1);
			mp4a.appendU32Values([
				0, 0,
				(audioDimensions.channels << 16) + 16, // channels | sample-size=16
				0, // reserved
				audioDimensions.sampleRate << 16
			]);

			const esds = mp4a.child("esds", 0, 0);
			esds.appendValues([
				0x03, // tag
				23 + config.aacAudioSpecificConfig.length,
				0, 2, // esID
				0, // pri + flags
					0x04, // tag
					15 + config.aacAudioSpecificConfig.length,
					0x40, 0x15, // profile:0x40 audio:0x05
					0xff, 0xff, 0xff, // buffer size
					0, 0, 0xff, 0xff, 0, 0, 0xff, 0xff, // max & average bit rates
						0x05, // tag
						config.aacAudioSpecificConfig.length
			]);
			esds.append(config.aacAudioSpecificConfig);
			esds.appendValues([0x06, 0x01, 0x02]);
			esds.close();
		}
		else if(config.avcc)
		{
			const avc1 = stsd.child("avc1");
			avc1.appendU64(1);
			avc1.appendU32Values([0, 0, 0, 0]);
			avc1.appendU16(videoDimensions.width);
			avc1.appendU16(videoDimensions.height);
			avc1.appendU32Values([0x480000, 0x480000, 0 ]);// resolutions, 72dpi h/v
			avc1.appendU16(1);
			avc1.appendU32Values([
				0, 0, 0, 0, 0, 0, 0, 0, // compressor name
				0x0018ffff // depth, -1
			]);

			const avcC = avc1.child("avcC");
			avcC.append(config.avcc);
			avcC.close();
		}
		else
			throw new ReferenceError("missing audio or video config");
	}

	_addTrex(parent, trackID) {
		const trex = parent.child("trex", 0, 0);
		trex.appendU32Values([trackID, 1, 1, 0, 0]);
		trex.close();
	}
}
