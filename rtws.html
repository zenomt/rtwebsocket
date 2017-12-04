<title>RTWebSocket API Reference</title>
<h1>RTWebSocket API Reference</h1>
<ul>
	<li> <a href="#Section-RTWebSocket"><code>RTWebSocket</code></a></li>
	<li> <a href="#Section-SendFlow"><code>SendFlow</code></a></li>
	<li> <a href="#Section-RecvFlow"><code>RecvFlow</code></a></li>
	<li> <a href="#Section-WriteReceipt"><code>WriteReceipt</code></a></li>
</ul>

<h3><a name="Section-RTWebSocket"></a>RTWebSocket</h3>

<pre>
&lt;script src="<a href="rtws.js">rtws.js</a>"&gt;&lt;/script&gt;

<a name="RTWebSocket"></a>[Constructor (DOMString uri)]
interface RTWebSocket {
    // constructor argument:
    //    uri: the WebSocket URI (ws://... or wss://...) to which to connect.

    const unsigned long PRI_LOWEST  = 0;
    const unsigned long PRI_HIGHEST = 7;

    const unsigned long PRI_BACKGROUND     = PRI_LOWEST;
    const unsigned long PRI_BULK           = 1;
    const unsigned long PRI_DATA           = 2;
    const unsigned long PRI_ROUTINE        = 3;
    const unsigned long PRI_PRIORITY       = 4;
    const unsigned long PRI_IMMEDIATE      = 5;
    const unsigned long PRI_FLASH          = 6;
    const unsigned long PRI_FLASH_OVERRIDE = PRI_HIGHEST;

    <a href="#SendFlow">SendFlow</a> openFlow (DOMString metadata, optional unsigned long priority);
    // open a new sending flow with metadata having priority (default: PRI_ROUTINE).
    // throws a new Error if this is not open, otherwise answers the new flow.

    void close ();
    // close this RTWebSocket and the the underlying WebSocket. all open sending
    // flows will receive onexception. all open receiving flows will receive oncomplete.

    readonly attribute boolean isOpen;
    // true if this RTWebSocket is open, false otherwise.

    readonly attribute double rtt;
    // the smoothed round trip time of this connection.

    readonly attribute double baseRTT;
    // the minimum of all measured round trip times over the last 5 minutes.

    readonly attribute unsigned long bytesInflight;
    // the number of bytes currently transmitted to the other side
    // that have not yet been acknowledged.

    callback OnRecvFlowCallback = void (<a href="#RecvFlow">RecvFlow</a> recvFlow);
    attribute OnRecvFlowCallback? onrecvflow;
    // if set, this callback is called when a new receiving flow (that is not an
    // associated return flow on a sending flow) is started. recvFlow must be accepted
    // during this callback or it will be rejected automatically.

    callback OnRTWSNotificationCallback = void (RTWebSocket rtws);

    attribute OnRTWSNotificationCallback? onopen;
    // if set, called when the underlying WebSocket connects to the far end.

    attribute OnRTWSNotificationCallback? onclose;
    // if set, called when this RTWebSocket is closed, either as a result of calling
    // the close() method, a protocol error, or the underlying WebSocket closing.
};
</pre>

<h3><a name="Section-SendFlow"></a>SendFlow</h3>

<pre>
<a name="SendFlow"></a>interface SendFlow {
    typedef (ArrayBuffer or ArrayBufferView or DOMString or byte[]) SendFlowData;
    <a name="Sendflow-write"></a><a href="#WriteReceipt">WriteReceipt</a> write (SendFlowData data, optional double startBy, optional double endBy, optional boolean capture);
    // queue data to send to the receiver. if data is a DOMString, it is encoded
    // to UTF-8, otherwise data is converted to a Uint8Array. if capture is true,
    // data is allowed to be captured to avoid a copy; otherwise a copy will be made.
    // in practice data will only be captured if it is a Uint8Array.
    // startBy is the time in seconds after queuing by which transmission of this message
    // should start before the message is abandoned. default Infinity.
    // endBy is the time in seconds after queuing by which transmission of this message,
    // if started, should complete before the message is abandoned. default Infinity.
    // answer a new <a href="#WriteReceipt">WriteReceipt</a> with which to track and control
    // delivery of this message.
    // throws a new Error if this flow is closed.

    void close ();
    // close this flow normally, completing it.

    void abandonQueuedMessages (optional double age);
    // abandon any queued messages at least as old as age seconds (default: 0).

    attribute unsigned long priority;
    // the priority of this flow. higher priority flows' data are sent before those of lower
    // priority flows, subject to the receivers' buffer advertisements. priority is clamped
    // between PRI_LOWEST and PRI_HIGHEST inclusive.

    attribute unsigned long sndbuf;
    // the advisory maximum bufferLength below which this flow is considered writable
    // (default 65536 bytes). data may still be written to the flow, memory permitting,
    // even if it is not writable.

    readonly attribute unsigned long bufferLength;
    // the count of the lengths, in bytes, of all queued messages that have not been
    // completely sent (or abandoned and removed from the queue).

    readonly attribute unsigned long rcvbuf;
    // the last received receive window advertisement.

    readonly attribute boolean writable;
    // true if this flow is open and bufferLength is less than sndbuf, false otherwise.

    readonly attribute boolean isOpen;
    // true if this flow is open, false otherwise.

    readonly attribute double unsentAge;
    // the age, in seconds, of the oldest unsent message in the transmission queue.

    void notifyWhenWritable ();
    // begin calling onwritable() when this flow is writable.

    callback OnWritableCallback boolean (SendFlow sendFlow);
    attribute OnWritableCallback? onwritable;
    // if set, called after notifyWritable() has been called when this
    // flow is writable, until this callback does not return true.

    callback OnExceptionCallback void (SendFlow sendFlow, (unsigned long or undefined) code, (DOMString or undefined) description);
    attribute OnExceptionCallback onexception;
    // called if this flow is still open and the receiver closed its end. if the
    // receiver sent a code and description, those are provided. callbacks should
    // be prepared for code or description to be undefined.
    
    callback OnRecvFlowCallback = void (<a href="#RecvFlow">RecvFlow</a> recvFlow);
    <a name="SendFlow-onrecvflow"></a>attribute OnRecvFlowCallback? onrecvflow;
    // if set, this callback is called when a new receiving flow (that is an
    // associated return flow to this sending flow) is started. recvFlow must
    // be accepted during this callback or it will be rejected automatically.
};
</pre>

<h3><a name="Section-RecvFlow"></a>RecvFlow</h3>

<pre>
<a name="RecvFlow"></a>interface RecvFlow {
    void accept ();
    // accept this new receiving flow. a new incoming receiving flow that is not
    // accepted in the onrecvflow callback is automatically rejected.

    <a href="#SendFlow">SendFlow</a> openReturnFlow (DOMString metadata, optional unsigned long pri);
    // open a new sending flow with metadata having priority (default: PRI_ROUTINE) associated
    // in return to this receiving flow.
    // throws a new Error if this RecvFlow is not open, otherwise answers the new flow.

    void close (optional unsigned long code, optional DOMString description);
    // reject and close this receiving flow, sending an exception back to the
    // sender with code and description, if set.

    readonly attribute DOMString metadata;
    // this flow's metadata set by the sender.

    readonly attribute boolean isOpen;
    // true if this flow is open, false otherwise.

    attribute unsigned long rcvbuf;
    // the maximum amount of data, in bytes, that can be inflight (unacknowledged) from
    // the sender. if paused is true, also the maximum amount of data that can be held for
    // delivery in the receive queue.

    readonly attribute unsigned long advertisement;
    // the receive window that would be sent to the sender at this moment.

    readonly attribute unsigned long bufferLength;
    // the number of bytes of messages in the receive queue.

    attribute boolean paused;
    // if true, onmessage will not be called and complete messages will be held
    // in the receive queue.  if false (default), messages will be delivered
    // as soon as they are completely received.

    readonly attribute <a href="#SendFlow">SendFlow</a> associatedSendFlow;
    // if set, indicates the SendFlow on which this flow was accepted in its
    // <a href="#SendFlow-onrecvflow">onrecvflow</a> callback.

    attribute DOMString mode;
    // either "binary" or "text" (default: "binary"), indicates the format
    // in which messages should be delivered to onmessage. if set to "text",
    // the message will be decoded as UTF-8 and delivered as a DOMString,
    // otherwise it will be delivered as a Uint8Array.

    callback OnMessageCallback void (RecvFlow recvFlow, (Uint8Array or DOMString) message, unsigned long number);
    attribute OnMessageCallback? onmessage;
    // if set, called when a message is received. recvFlow is the flow on which this
    // message was received. the type of message depends on mode. number is the
    // ordinal number of this message according to the sender, including any abandoned
    // messages that were not delivered. number can be used to detect abandoned messages
    // by paying attention to gaps in sequence.

    callback OnCompleteCallback void (RecvFlow recvFlow);
    attribute OnCompleteCallback oncomplete;
    // if set, called when this flow is complete.
};
</pre>

<h3><a href="Section-WriteReceipt"></a>WriteReceipt</h3>

<pre>
<a name="WriteReceipt"></a>interface WriteReceipt {
    void abandon ();
    // abandon this message if not sent already.

    attribute double startBy;
    attribute double endBy;
    // change the startBy and endBy times for this message.
    // see <a href="#Sendflow-write">SendFlow.write()</a> for a description of these
    // attributes. changing startBy has no effect if transmission of this message
    // has already started.

    readonly attribute boolean abandoned;
    // true if this message is abandoned (either by timing out or by being manually
    // abandoned), false if it was or may still be sent.

    readonly attribute boolean sent;
    // true if this message was completely sent, false otherwise (for example,
    // it is still queued or was abandoned).

    readonly attribute boolean started;
    // true if any part of this message has been sent, otherwise false.

    readonly double age;
    // the duration in seconds since this message was queued.

    callback WriteReceiptCallback void (WriteReceipt receipt);

    attribute WriteReceiptCallback? onsent;
    // if set, called when this message has been completely sent.

    attribute WriteReceiptCallback? onabandoned;
    // if set, called when this message is abandoned before being completely sent.
};
</pre>
