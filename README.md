# Videostream

Streams data from a file-like seekable object into a &lt;video&gt; or &lt;audio&gt; node (a `HTMLMediaElement`).
Seeking the media element will request a different byte range from the incoming
file-like object.

For now only mp4 files are supported. The goal is to support
most files that conform to ISO/IEC 14496-12.

Version 2 is completely rewritten and substantially more robust
than the previous version that relied on mp4box.js. The only major regression
compared to the previous architecture is that fragmented mp4 files aren't
supported. If this is a problem I may add support again at some point.

Support for most other formats will take significant work.

## Usage

Videostream just exports a function. Use it like this:

``` js
var exampleFile = {
	createReadStream: function (opts) {
		var start = opts.start;
		var end = opts.end;
		// Return a readable stream that provides the bytes
		// between offsets "start" and "end" inclusive
	}
}

var videostream = require('videostream');

var video = document.createElement('video');
videostream(exampleFile, video);
```

## License

MIT. Copyright (c) John Hiesey.