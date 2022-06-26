RTWebSocket
===========

RTWebSocket is a simple protocol, inspired by [RTMFP (RFC 7016)][rfc7016],
that multiplexes prioritized message flows over a [WebSocket][rfc6455]
connection. Reference implementations are provided in JavaScript and Python (so far).
A C++ implementation is available in
[the RTMFP Library project test directory][rtmfp-cpp].

Protocol features include:

  - Multiple parallel unidirectional message flows over a single WebSocket
  - Flows have binary metadata instead of port numbers
  - Return flow association for generalized bidirectional communication
  - The sender can abandon a message after queuing, even if transmission of the message has started
  - Independent per-flow flow control

Features of the reference implementations:

  - A message can be given an expiration time when queued, after which it is automatically abandoned
  - Queuing a message returns a `WriteReceipt` that can be used to track delivery and manually abandon the message
  - [Bufferbloat][] mitigation
  - A new incoming return flow arrives as a callback on the flow to which it is associated
  - Flow priority/precedence can be changed on the fly
  - The receiver can suspend message delivery per-flow

The protocol is described in [protocol][].

Web IDL documentation for the reference implementation is in [API.md][].

License
=======

Licensed under the MIT License.


  [rfc7016]:     https://tools.ietf.org/html/rfc7016
  [rfc6455]:     https://tools.ietf.org/html/rfc6455
  [Bufferbloat]: https://www.bufferbloat.net/projects/
  [API.md]:      API.md
  [protocol]:    protocol
  [rtmfp-cpp]:   https://github.com/zenomt/rtmfp-cpp
