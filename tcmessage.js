// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

// TC (RTMFP/RTMP "Tin-Can") message helpers. See RFC 7425, FLV, SWF, and RTMP specs.

var com_zenomt_TCMessage = {};

; (function() {

const TC = com_zenomt_TCMessage;

TC.TCMSG_SET_CHUNK_SIZE   = 1; // Not used with RTMFP/RTWebSocket
TC.TCMSG_ABORT_MESSAGE    = 2; // Not used with RTMFP/RTWebSocket
TC.TCMSG_ACKNOWLEDGEMENT  = 3; // Not used with RTMFP/RTWebSocket
TC.TCMSG_WINDOW_ACK_SIZE  = 5; // Not used with RTMFP/RTWebSocket
TC.TCMSG_SET_PEER_BW      = 6; // Not used with RTMFP/RTWebSocket
TC.TCMSG_USER_CONTROL     = 4;
TC.TCMSG_COMMAND          = 20;
TC.TCMSG_COMMAND_EX       = 17;
TC.TCMSG_DATA             = 18;
TC.TCMSG_DATA_EX          = 15;
TC.TCMSG_SHARED_OBJECT    = 19;
TC.TCMSG_SHARED_OBJECT_EX = 16;
TC.TCMSG_AUDIO            = 8;
TC.TCMSG_VIDEO            = 9;
TC.TCMSG_AGGREGATE        = 22; // Should not be used with RTMFP/RTWebSocket

TC.TC_USERCONTROL_STREAM_BEGIN = 0;
TC.TC_USERCONTROL_STREAM_EOF = 1;
TC.TC_USERCONTROL_STREAM_DRY = 2;
TC.TC_USERCONTROL_SET_BUFFER_LENGTH = 3;
TC.TC_USERCONTROL_STREAM_IS_RECORDED = 4;
TC.TC_USERCONTROL_PING_REQUEST = 6;  // Should not be used with RTMFP/RTWebSocket
TC.TC_USERCONTROL_PING_RESPONSE = 7;  // Should not be used with RTMFP/RTWebSocket
TC.TC_USERCONTROL_FLOW_SYNC = 34; // RFC 7425 §5.2
TC.TC_USERCONTROL_SET_KEEPALIVE = 41; // RFC 7425 §5.3.4

TC.TC_SET_PEER_BW_LIMIT_HARD = 0;
TC.TC_SET_PEER_BW_LIMIT_SOFT = 1;
TC.TC_SET_PEER_BW_LIMIT_DYNAMIC = 2;

TC.TC_VIDEO_ENHANCED_FLAG_ISEXHEADER = 8 << 4;

TC.TC_VIDEO_FRAMETYPE_IDR           = 1 << 4;
TC.TC_VIDEO_FRAMETYPE_INTER         = 2 << 4;
TC.TC_VIDEO_FRAMETYPE_DISPOSABLE    = 3 << 4;
TC.TC_VIDEO_FRAMETYPE_GENERATED_IDR = 4 << 4;
TC.TC_VIDEO_FRAMETYPE_COMMAND       = 5 << 4;
TC.TC_VIDEO_FRAMETYPE_MASK          = 0x70;

TC.TC_VIDEO_CODEC_NONE      = 0;
TC.TC_VIDEO_CODEC_SPARK     = 2;
TC.TC_VIDEO_CODEC_SCREEN    = 3;
TC.TC_VIDEO_CODEC_VP6       = 4;
TC.TC_VIDEO_CODEC_VP6_ALPHA = 5;
TC.TC_VIDEO_CODEC_SCREEN_V2 = 6;
TC.TC_VIDEO_CODEC_AVC       = 7;
TC.TC_VIDEO_CODEC_MASK      = 0x0f;

TC.TC_VIDEO_ENH_CODEC_AV1  = 0x61763031; // 'av01'
TC.TC_VIDEO_ENH_CODEC_AVC  = 0x61766331; // 'avc1'
TC.TC_VIDEO_ENH_CODEC_VP9  = 0x76703039; // 'vp09'
TC.TC_VIDEO_ENH_CODEC_HEVC = 0x68766331; // 'hvc1'

TC.TC_VIDEO_AVCPACKET_AVCC = 0;
TC.TC_VIDEO_AVCPACKET_NALU = 1;
TC.TC_VIDEO_AVCPACKET_EOS  = 2;

TC.TC_VIDEO_COMMAND_SEEK_START = 1;
TC.TC_VIDEO_COMMAND_SEEK_END   = 2;
TC.TC_VIDEO_COMMAND_RANDOM_ACCESS_CHECKPOINT = 3;

TC.TC_VIDEO_ENH_PACKETTYPE_SEQUENCE_START         = 0;
TC.TC_VIDEO_ENH_PACKETTYPE_CODED_FRAMES           = 1;
TC.TC_VIDEO_ENH_PACKETTYPE_SEQUENCE_END           = 2;
TC.TC_VIDEO_ENH_PACKETTYPE_CODED_FRAMES_X         = 3;
TC.TC_VIDEO_ENH_PACKETTYPE_METADATA               = 4;
TC.TC_VIDEO_ENH_PACKETTYPE_MPEG2TS_SEQUENCE_START = 5;
TC.TC_VIDEO_ENH_PACKETTYPE_MULTITRACK             = 6;
TC.TC_VIDEO_ENH_PACKETTYPE_MASK                   = 0x0f;

TC.TC_AUDIO_CODEC_LPCM_PLATFORM    =  0 << 4;
TC.TC_AUDIO_CODEC_ADPCM            =  1 << 4;
TC.TC_AUDIO_CODEC_MP3              =  2 << 4;
TC.TC_AUDIO_CODEC_LPCM_LE          =  3 << 4;
TC.TC_AUDIO_CODEC_NELLYMOSER_16KHZ =  4 << 4;
TC.TC_AUDIO_CODEC_NELLYMOSER_8KHZ  =  5 << 4;
TC.TC_AUDIO_CODEC_NELLYMOSER       =  6 << 4;
TC.TC_AUDIO_CODEC_G711_A_LAW       =  7 << 4;
TC.TC_AUDIO_CODEC_G711_MU_LAW      =  8 << 4;
TC.TC_AUDIO_CODEC_AAC              = 10 << 4;
TC.TC_AUDIO_CODEC_SPEEX            = 11 << 4;
TC.TC_AUDIO_CODEC_MP3_8KHZ         = 14 << 4;
TC.TC_AUDIO_CODEC_DEVICE_SPECIFIC  = 15 << 4;
TC.TC_AUDIO_CODEC_MASK             = 0xf0;

TC.TC_AUDIO_ENH_CODEC_MP3  = 0x2e6d7033; // '.mp3'
TC.TC_AUDIO_ENH_CODEC_OPUS = 0x4f707573; // 'Opus'
TC.TC_AUDIO_ENH_CODEC_AC3  = 0x61632d33; // 'ac-3'
TC.TC_AUDIO_ENH_CODEC_EAC3 = 0x65632d33; // 'ec-3'
TC.TC_AUDIO_ENH_CODEC_FLAC = 0x664c6143; // 'fLaC'
TC.TC_AUDIO_ENH_CODEC_AAC  = 0x6d703461; // 'mp4a'

TC.TC_AUDIO_RATE_5500  = 0 << 2;
TC.TC_AUDIO_RATE_11025 = 1 << 2;
TC.TC_AUDIO_RATE_22050 = 2 << 2;
TC.TC_AUDIO_RATE_44100 = 3 << 2;
TC.TC_AUDIO_RATE_MASK  = 0x03 << 2;

TC.TC_AUDIO_SOUNDSIZE_8    = 0 << 1;
TC.TC_AUDIO_SOUNDSIZE_16   = 1 << 1;
TC.TC_AUDIO_SOUNDSIZE_MASK = 0x01 << 1;

TC.TC_AUDIO_SOUND_MONO   = 0;
TC.TC_AUDIO_SOUND_STEREO = 1;
TC.TC_AUDIO_SOUND_MASK   = 0x01;

TC.TC_AUDIO_AACPACKET_AUDIO_SPECIFIC_CONFIG = 0;
TC.TC_AUDIO_AACPACKET_AUDIO_AAC             = 1;

TC.TC_AUDIO_ENH_PACKETTYPE_SEQUENCE_START      = 0;
TC.TC_AUDIO_ENH_PACKETTYPE_CODED_FRAMES        = 1;
TC.TC_AUDIO_ENH_PACKETTYPE_SEQUENCE_END        = 2;
TC.TC_AUDIO_ENH_PACKETTYPE_MULTICHANNEL_CONFIG = 4;
TC.TC_AUDIO_ENH_PACKETTYPE_MULTITRACK          = 5;
TC.TC_AUDIO_ENH_PACKETTYPE_MASK                = 0x0f;

TC.TC_AV_ENH_MULTITRACKTYPE_ONE_TRACK               = 0 << 4;
TC.TC_AV_ENH_MULTITRACKTYPE_MANY_TRACKS             = 1 << 4;
TC.TC_AV_ENH_MULTITRACKTYPE_MANY_TRACKS_MANY_CODECS = 2 << 4;
TC.TC_AV_ENH_MULTITRACKTYPE_MASK                    = 0xf0;

TC.TCMETADATA_FLAG_SID = 0x04; // Stream ID Present, required
TC.TCMETADATA_FLAG_RXI_MASK = 0x01; // Receive Intent

TC.TCMETADATA_RXI_SEQUENCE = 0; // Original queuing order.
TC.TCMETADATA_RXI_NETWORK = 1; // Network arrival order.

function checkLimit(bytes, limit) {
	if((undefined === limit) || (limit < 0) || (limit > bytes.length))
		return bytes.length;
	return limit;
}

function VLU() {}

/**
 * Encode a non-negative integer into a VLU (RFC 7016 §2.1.2)
 * @param {unsigned long} num - The number to encode.
 * @param {array-like} [dst=[]] - The encoding destination. Bytes (as integers) are push()ed to dst.
 * @return {array-like} Returns dst as a convenience.
 */
VLU.encode = function(num, dst) {
	dst = dst || [];
	var rv = [];
	var more = 0;
	do {
		var digit = num & 0x7f;
		rv.push(digit + more);
		num = (num - digit) / 128;
		more = 128;
	} while (num >= 1);
	rv.reverse();
	for(const i of rv)
		dst.push(i);
	return dst;
}

/**
 * Decode an encoded VLU. Returns number of bytes decoded or 0 on error.
 * @param {(array|Uint8Array)} bytes - Buffer where VLU is stored.
 * @param {int} [cursor=0] - Where in bytes to start decoding.
 * @param {int} [limit=-1] - Where in bytes to not go past while decoding. Negative or missing means bytes.length.
 * @param {array} [dst] - Destination, successfully decoded number is push()ed to dst.
 * @return {int} The number of bytes consumed to decode one VLU, or 0 on error.
 */
VLU.decode = function(bytes, cursor, limit, dst) {
	var acc = 0;
	var length = 0;
	dst = dst || [];
	limit = checkLimit(bytes, limit);

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
		return 0;

	dst.push(acc);

	return length;
}

TC.VLU = VLU;

function Metadata() {}

/**
 * Encode TC flow metadata according to RFC 7425 §5.1.1.
 * @param {unsigned} [streamID=0] - The stream ID. Always present for TC flows, default 0.
 * @param {int} [rxi=TCMETADATA_RXI_SEQUENCE] - The receive intent hint.
 * @param {array} [dst=[]] - The encoding destination. Bytes (as integers) are push()ed to dst.
 * @return {array} Returns dst as a convenience.
 */
Metadata.encode = function(streamID, rxi, dst) {
	streamID = streamID || 0;
	dst = dst || [];
	rxi = (rxi || TC.TCMETADATA_RXI_SEQUENCE) & TC.TCMETADATA_FLAG_RXI_MASK;

	dst.push(0x54); // T
	dst.push(0x43); // C
	dst.push(TC.TCMETADATA_FLAG_SID | rxi);
	TC.VLU.encode(streamID, dst);

	return dst;
}

/**
 * Decode TC flow metadata according to RFC 7425 §5.1.1.
 * @param {(array|Uint8Array)} bytes - Buffer from which to read encoded metadata.
 * @param {int} [cursor=0] - Where in bytes to start decoding.
 * @param {int} [limit-1] - Where in bytes to not go past while decoding. Negative or missing means bytes.length.
 * @returns {{streamID:unsigned, rxi:int}} Decoded metadata, or undefined on error.
 */
Metadata.decode = function(bytes, cursor, limit) {
	limit = checkLimit(bytes, limit);
	cursor = cursor || 0;
	const anchor = cursor;

	if(limit - cursor < 4) // minimum metadata size with streamID
		return;
	if((0x54 != bytes[cursor]) || (0x43 != bytes[cursor + 1]) || (TC.TCMETADATA_FLAG_SID & bytes[cursor + 2] != TC.TCMETADATA_FLAG_SID))
		return;

	var rxi = bytes[cursor + 2] & TC.TCMETADATA_FLAG_RXI_MASK;

	cursor += 3;

	var streamID = [];
	var consumed = TC.VLU.decode(bytes, cursor, limit, streamID);
	if(consumed < 1)
		return;
	cursor += consumed;

	return { streamID: streamID[0], rxi };
}

TC.Metadata = Metadata;

function Message() {}

/**
 * Encode a TC message header according to RFC 7425 §5.1.2.
 * @param {uint8} type - Type of message.
 * @param {uint32} timestamp - Message timestamp.
 * @param {array-like} [dst=[]] - Encoding destination. Bytes (as integers) are push()ed to dst.
 * @return {array} Returns dst as a convenience.
 */
Message.encodeHeader = function(type, timestamp, dst) {
	dst = dst || [];
	dst.push(type);
	dst.push((timestamp >> 24) & 0xff);
	dst.push((timestamp >> 16) & 0xff);
	dst.push((timestamp >>  8) & 0xff);
	dst.push((timestamp      ) & 0xff);
	return dst;
}

/**
 * Construct a complete encoded TC message according to RFC 7425 §5.1.2.
 * @param {uint8} type - Type of message.
 * @param {uint32} timestamp - Message timestamp.
 * @param {...(array|Uint8Array)} byteses - Zero or more blocks of bytes to be appended (each in its entirety) to the message.
 * @return {Uint8Array} Complete message.
 */
Message.make = function(type, timestamp, ...byteses) {
	const header = Message.encodeHeader(type, timestamp);
	const totalLength = byteses.reduce(function(acc, v) { return acc + v.length; }, header.length);

	var rv = new Uint8Array(totalLength);
	rv.set(header);
	var cursor = header.length;
	for(const bytes of byteses)
	{
		rv.set(bytes, cursor);
		cursor += bytes.length;
	}

	return rv;
}

/**
 * Decode a TC message header according to RFC 7425 §5.1.2.
 * @param {(array|Uint8Array)} bytes - Buffer from which to read.
 * @param {int} [cursor=0] - Where in bytes to start decoding.
 * @param {int} [limit-1] - Where in bytes to not go past while decoding. Negative or missing means bytes.length.
 * @param {Object} [dst={}] - Decoding destination, sets properties per return description.
 * @return {{type:int, timestamp:uint32, consumed:int}} - Returns dst or undefined on error. consumed is number of bytes read (always 5).
 */
Message.decodeHeader = function(bytes, cursor, limit, dst) {
	dst = dst || {};
	cursor = cursor || 0;
	limit = checkLimit(bytes, limit);

	if(limit - cursor < 5)
		return;

	dst.type = bytes[cursor++];
	var timestamp = bytes[cursor++]; timestamp *= 256;
	timestamp += bytes[cursor++]; timestamp *= 256;
	timestamp += bytes[cursor++]; timestamp *= 256;
	timestamp += bytes[cursor++];
	dst.timestamp = timestamp;
	dst.consumed = 5;

	return dst;
}

TC.Message = Message;

})();
