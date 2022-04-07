// Copyright © 2022 Michael Thornburgh
// SPDX-License-Identifier: MIT

// AMF0 encode/decode

var com_zenomt_AMF0 = {};

; (function() {

const AMF0 = com_zenomt_AMF0;

AMF0.AMF0_NUMBER_MARKER = 0x00;
AMF0.AMF0_BOOLEAN_MARKER = 0x01;
AMF0.AMF0_STRING_MARKER = 0x02;
AMF0.AMF0_OBJECT_MARKER = 0x03;
AMF0.AMF0_NULL_MARKER = 0x05;
AMF0.AMF0_UNDEFINED_MARKER = 0x06;
AMF0.AMF0_REFERENCE_MARKER = 0x07;
AMF0.AMF0_ECMAARRAY_MARKER = 0x08;
AMF0.AMF0_OBJECT_END_MARKER = 0x09;
AMF0.AMF0_STRICT_ARRAY_MARKER = 0x0a;
AMF0.AMF0_DATE_MARKER = 0x0b;
AMF0.AMF0_LONG_STRING_MARKER = 0x0c;
AMF0.AMF0_UNSUPPORTED_MARKER = 0x0d;
AMF0.AMF0_XML_DOCUMENT_MARKER = 0x0f;
AMF0.AMF0_TYPED_OBJECT_MARKER = 0x10;
AMF0.AMF0_AVMPLUS_OBJECT_MARKER = 0x11;

AMF0.MAX_DEPTH = 32;

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

AMF0.UTF8 = new UTF8();

function encodeNumber(n, dst) {
	var buffer = new ArrayBuffer(8);
	var view = new DataView(buffer);
	var u8 = new Uint8Array(buffer);

	view.setFloat64(0, n, false);

	dst.push(AMF0.AMF0_NUMBER_MARKER);
	for(const each of u8.values())
		dst.push(each);
}

function encodeString(s, dst) {
	const utf = AMF0.UTF8.encode(s);
	const size = utf.length;

	if(size > 65535)
	{
		dst.push(AMF0.AMF0_LONG_STRING_MARKER);
		dst.push((size >> 24) & 0xff);
		dst.push((size >> 16) & 0xff);
		dst.push((size >>  8) & 0xff);
		dst.push((size      ) & 0xff);
	}
	else
	{
		dst.push(AMF0.AMF0_STRING_MARKER);
		dst.push((size >>  8) & 0xff);
		dst.push((size      ) & 0xff);
	}

	for(const each of utf)
		dst.push(each);
}

function encodeArray(val, dst) {
	const size = val.length;

	dst.push(AMF0.AMF0_STRICT_ARRAY_MARKER);
	dst.push((size >> 24) & 0xff);
	dst.push((size >> 16) & 0xff);
	dst.push((size >>  8) & 0xff);
	dst.push((size      ) & 0xff);

	for(const each of val)
		AMF0.encode(each, dst);
}

function encodeObject(val, dst) {
	dst.push(AMF0.AMF0_OBJECT_MARKER);

	for(const each in val)
	{
		const utf = AMF0.UTF8.encode(each);
		const size = utf.length;
		if(size > 65535)
			continue; // skip names that are too long.
		dst.push((size >>  8) & 0xff);
		dst.push((size      ) & 0xff);
		for(const b of utf)
			dst.push(b);

		AMF0.encode(val[each], dst);
	}

	dst.push(0);
	dst.push(0);
	dst.push(AMF0.AMF0_OBJECT_END_MARKER);
}

/**
 * Encode a JSON-compatible value to AMF0. No object references/cycles.
 * @param {any} val - The value to encode (string, number, true, false, undefined, array, object).
 * @param {array} dst - The encoding destination. Bytes (as integers) are push()ed to dst.
 * @return {array} Returns dst as a convenience.
 */
AMF0.encode = function(val, dst) {
	dst = dst || [];

	if(undefined === val)
		dst.push(AMF0.AMF0_UNDEFINED_MARKER);
	else if(null === val)
		dst.push(AMF0.AMF0_NULL_MARKER);
	else if("boolean" == typeof(val))
	{
		dst.push(AMF0.AMF0_BOOLEAN_MARKER);
		dst.push(val ? 1 : 0);
	}
	else if("number" == typeof(val))
		encodeNumber(val, dst);
	else if("string" == typeof(val))
		encodeString(val, dst);
	else if(Array.isArray(val))
		encodeArray(val, dst);
	else if("object" == typeof(val))
		encodeObject(val, dst);
	else
		throw new ReferenceError("can't serialize to AMF0");

	return dst;
}

/**
 * Encode many JSON-compatible values to AMF0, concatenating them to a supplied destination.
 * @param {array} dst - Encoding destination. Bytes (as integers) are push()ed to dst.
 * @param {...any} vals - Zero or more values to encode (string, number, true, false, undefined, array, objectc).
 * @return {array} Returns dst as a convenience.
 */
AMF0.encodeManyTo = function(dst, ...vals) {
	for(const val of vals)
		AMF0.encode(val, dst);
	return dst;
}

/**
 * Convenience function, encode many JSON-compatible values to AMF0, concatenating them.
 * @param {...any} vals - Zero or more values to encode (string, number, true, false, undefined, array, objectc).
 * @return {array} The values encoded to AMF0.
 */
AMF0.encodeMany = function(...vals) {
	return AMF0.encodeManyTo([], ...vals);
}

function decodeNumber(bytes, cursor, limit, dst)
{
	if(limit - cursor < 9)
		return 0;

	cursor++;

	var buffer = new ArrayBuffer(8);
	var view = new DataView(buffer);
	var u8 = new Uint8Array(buffer);

	u8[0] = bytes[cursor++];
	u8[1] = bytes[cursor++];
	u8[2] = bytes[cursor++];
	u8[3] = bytes[cursor++];
	u8[4] = bytes[cursor++];
	u8[5] = bytes[cursor++];
	u8[6] = bytes[cursor++];
	u8[7] = bytes[cursor++];

	dst.push(view.getFloat64(0, false));

	return 9;
}

function decodeString(bytes, cursor, limit, dst)
{
	const anchor = cursor;
	var size;

	if(AMF0.AMF0_STRING_MARKER == bytes[cursor++])
	{
		if(limit - cursor < 2)
			return 0;

		size = bytes[cursor++]; size <<= 8;
		size += bytes[cursor++];
	}
	else
	{
		if(limit - cursor < 4)
			return 0;

		size = bytes[cursor++]; size *= 256; // Shifting implies signed int32 in JS, only 31 bits for unsigned.
		size += bytes[cursor++]; size *= 256;
		size += bytes[cursor++]; size *= 256;
		size += bytes[cursor++];
	}

	if(limit < cursor + size)
		return 0;

	dst.push(AMF0.UTF8.decode(bytes, cursor, cursor + size));
	cursor += size;

	return cursor - anchor;
}

function decodeArray(bytes, cursor, limit, dst, maxDepth)
{
	const anchor = cursor;

	cursor++;
	if(limit - cursor < 4)
		return 0;

	var size = bytes[cursor++]; size *= 256;
	size += bytes[cursor++]; size *= 256;
	size += bytes[cursor++]; size *= 256;
	size += bytes[cursor++];

	var rv = [];
	while(size--)
	{
		var tmp = [];
		var consumed = AMF0.decode(bytes, cursor, limit, tmp, maxDepth - 1);
		if(0 == consumed)
			return 0;
		rv.push(tmp.shift());
		cursor += consumed;
	}

	dst.push(rv);

	return cursor - anchor;
}

function decodeObject(bytes, cursor, limit, dst, maxDepth)
{
	const anchor = cursor;

	if(AMF0.AMF0_TYPED_OBJECT_MARKER == bytes[cursor++])
	{
		if(limit - cursor < 2)
			return 0;
		var classNameSize = bytes[cursor++]; classNameSize <<= 8;
		classNameSize += bytes[cursor++];

		if(limit - cursor < classNameSize)
			return 0;
		cursor += classNameSize; // skip it, we're not ActionScript
	}

	var rv = {};
	while(limit - cursor >= 3)
	{
		var keyLength = bytes[cursor++]; keyLength <<= 8;
		keyLength += bytes[cursor++];

		if(limit - cursor < keyLength)
			return 0;

		if((0 == keyLength) && (AMF0.AMF0_OBJECT_END_MARKER == bytes[cursor])) // safe
		{
			cursor++;
			dst.push(rv);
			return cursor - anchor;
		}

		var key = AMF0.UTF8.decode(bytes, cursor, cursor + keyLength);
		cursor += keyLength;

		var tmp = [];
		var consumed = AMF0.decode(bytes, cursor, limit, tmp, maxDepth - 1);
		if(0 == consumed)
			return 0;
		rv[key] = tmp.shift();

		cursor += consumed;
	}

	return 0;
}

function decodeECMAArray(bytes, cursor, limit, dst, maxDepth)
{
	const anchor = cursor;

	cursor++;
	if(limit - cursor < 4)
		return 0;

	var size = bytes[cursor++]; size *= 256;
	size += bytes[cursor++]; size *= 256;
	size += bytes[cursor++]; size *= 256;
	size += bytes[cursor++];

	var rv = {};

	while(size--)
	{
		if(limit - cursor < 3)
			return 0;

		var keyLength = bytes[cursor++]; keyLength <<= 8;
		keyLength += bytes[cursor++];

		if(limit - cursor < keyLength)
			return 0;

		var key = AMF0.UTF8.decode(bytes, cursor, cursor + keyLength);
		cursor += keyLength;

		if((cursor < limit) && (AMF0.AMF0_OBJECT_END_MARKER == bytes[cursor]) && (0 == keyLength))
		{
			cursor++;
			continue;
		}

		var tmp = [];
		var consumed = AMF0.decode(bytes, cursor, limit, tmp, maxDepth - 1);
		if(0 == consumed)
			return 0;

		rv[key] = tmp.shift();

		cursor += consumed;
	}

	dst.push(rv);

	return cursor - anchor;
}

/**
 * Decode AMF0 to a JSON-compatible Javascript value. Object references/cycles, Dates, XML Documents, and AMF3 not supported.
 * @param {(array|Uint8Array)} bytes - The AMF0 encoded value. Any object that has a length and is addressed with [] works.
 * @param {int} [cursor=0] - Where in bytes to start decoding.
 * @param {int} [limit=bytes.length] - Where in bytes to not go past while decoding. Negative or missing means bytes.length.
 * @param {array} [dst=[]] - Destination, decoded object is push()ed to dst.
 * @param {int} [maxDepth=AMF0.MAX_DEPTH] - The maximum depth for nested objects, for safety.
 * @return {int} The number of bytes consumed to decode one object, or 0 on error.
 */
AMF0.decode = function(bytes, cursor, limit, dst, maxDepth) {
	cursor = cursor || 0;
	if(undefined === maxDepth)
		maxDepth = AMF0.MAX_DEPTH;
	if(maxDepth < 1)
		return 0;

	dst = dst || [];
	if((limit < 0) || (limit > bytes.length))
		limit = bytes.length;
	if(limit <= cursor)
		return 0;

	switch(bytes[cursor])
	{
	case AMF0.AMF0_UNDEFINED_MARKER:
		dst.push(undefined);
		return 1;

	case AMF0.AMF0_NULL_MARKER:
		dst.push(null);
		return 1;

	case AMF0.AMF0_BOOLEAN_MARKER:
		if(cursor + 1 >= limit)
			return 0;
		dst.push(!!bytes[cursor + 1]);
		return 2;

	case AMF0.AMF0_NUMBER_MARKER:
		return decodeNumber(bytes, cursor, limit, dst);

	case AMF0.AMF0_STRING_MARKER:
	case AMF0.AMF0_LONG_STRING_MARKER:
		return decodeString(bytes, cursor, limit, dst);

	case AMF0.AMF0_STRICT_ARRAY_MARKER:
		return decodeArray(bytes, cursor, limit, dst, maxDepth);

	case AMF0.AMF0_OBJECT_MARKER:
	case AMF0.AMF0_TYPED_OBJECT_MARKER:
		return decodeObject(bytes, cursor, limit, dst, maxDepth);

	case AMF0.AMF0_ECMAARRAY_MARKER:
		return decodeECMAArray(bytes, cursor, limit, dst, maxDepth);

	// case AMF0.AMF0_OBJECT_END_MARKER: 
	// case AMF0.AMF0_DATE_MARKER:
	// case AMF0.AMF0_UNSUPPORTED_MARKER:
	// case AMF0.AMF0_XML_DOCUMENT_MARKER:
	// case AMF0.AMF0_AVMPLUS_OBJECT_MARKER:
	// case AMF0.AMF0_REFERENCE_MARKER:
	}

	return 0;
}

/**
 * Decode as many sequential AMF0 objects as possible from bytes.
 * @param {(array|Uint8Array)} bytes - The AMF0 encoded values. Any object that has a length and is addressed with [] works.
 * @param {int} [cursor=0] - Where in bytes to start decoding.
 * @param {int} [limit=bytes.length] - Where in bytes to not go past while decoding. Negative or missing means bytes.length.
 * @param {int} [maxDepth=AMF0.MAX_DEPTH] - The maximum depth for nested objects, for safety.
 * @return {array} As many AMF0 objects as could be decoded before running out of bytes or error.
 */
AMF0.decodeMany = function(bytes, cursor, limit, maxDepth) {
	const dst = [];
	if(undefined === limit)
		limit = -1;
	if((limit < 0) || (limit > bytes.length))
		limit = bytes.length;
	cursor = cursor || 0;

	while(cursor < limit)
	{
		const rv = AMF0.decode(bytes, cursor, limit, dst, maxDepth);
		if(rv < 1)
			break;
		cursor += rv;
	}

	return dst;
}

})();
