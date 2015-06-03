# Videostream

Streams data from a file-like seekable object into a &lt;video&gt; or &lt;audio&gt; node (a `HTMLMediaElement`).
Seeking the media element will request a different byte range from the incoming
file-like object.

For now only mp4 files are supported. The goal is to support
most files that conform to ISO/IEC 14496-12, but there are definitely
lots of bugs at this point! It uses a fork of
[mp4box.js](https://github.com/gpac/mp4box.js/) with a bunch of bug fixes
to repackage the files; I hope to put many of these fixes back upstream
soon.

Support for most other formats will take significant work.

## Usage

Videostream just exports a function. Use it like this:

```
var exampleFile = {
	length: 100000, // Total size of the file
	createReadStream: function (opts) {
		var start = opts.start;
		var end = opts.end;
		// Return a readable stream that provides the bytes
		// between offsets "start" and "end" inclusive
	}
}

var videostream = require('./videostream');

var video = document.createElement('video');
videostream(exampleFile, video);
```

## License

MIT. Copyright (c) John Hiesey.