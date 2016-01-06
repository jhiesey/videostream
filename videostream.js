var debug = require('debug')('videostream');
var MP4Box = require('videostream-mp4box');

var EPSILON = 0.01; // seconds of "slop" in floating-point time calculations
var MAX_BUFFER = 60; // seconds of buffer before pausing the incoming stream

/**
 * Stream data from `file` into `mediaElem`.
 * `file` must be an object with a `length` property giving the file size in bytes,
 * and a `createReadStream(opts)` method that retunr a string and accepts opts.start
 * and opts.end to specify a byte range (inclusive) to fetch.
 * @param {File} file described above
 * @param {HTMLMediaElement} mediaElem <audio> or <video> element
 * @param {Object} opts Options
 * @param {number=} opts.debugTrack Track to save for debugging. Defaults to -1 (none)
 */
module.exports = function (file, mediaElem, opts) {
	opts = opts || {};
	var debugTrack = opts.debugTrack || -1;
	var debugBuffers = [];

	function init () {
		mediaElem.addEventListener('waiting', onWaiting);
		mediaElem.addEventListener('timeupdate', onTimeUpdate);
	}
	init();

	var destroyed = false;
	function destroy (reason) {
		destroyed = true;
		mediaElem.removeEventListener('waiting', onWaiting);
		mediaElem.removeEventListener('timeupdate', onTimeUpdate);
		if (mediaSource.readyState === 'open')
			mediaSource.endOfStream(reason);
	}

	// Determine if it is a good idea to append to the SourceBuffer for the
	// given track, based on how full the browser's buffer is. Returns
	// true if appending is suggested
	function shouldAppend (track) {
		var buffered = track.buffer.buffered;
		var currentTime = mediaElem.currentTime;
		var bufferEnd = -1; // end of the buffer
		// This is a little over complex because some browsers seem to separate the
		// buffered region into multiple sections with slight gaps.
		// TODO: figure out why there are gaps in the buffer. This may be due to
		// timestamp errors in mp4box, or due to browsers not liking the single-frame
		// segments mp4box generates
		for (var i = 0; i < buffered.length; i++) {
			var start = buffered.start(i);
			var end = buffered.end(i) + EPSILON;

			if (start > currentTime) {
				// Reached past the joined buffer
				break;
			} else if (bufferEnd >= 0 || currentTime <= end) {
				// Found the start/continuation of the joined buffer
				bufferEnd = end;
			}
		}

		var bufferedTime = bufferEnd - currentTime;
		if (bufferedTime < 0)
			bufferedTime = 0;

		debug('Buffer length: %f', bufferedTime);

		return bufferedTime <= MAX_BUFFER;
	}

	var mediaSource = new MediaSource();
	mediaSource.addEventListener('sourceopen', function () {
		makeRequest(0);
	});
	mediaElem.src = window.URL.createObjectURL(mediaSource);

	var mp4box = new MP4Box();
	mp4box.onError = function (err) {
		debug('MP4Box error: %s', err.message);
		if(detachStream) {
			detachStream();
		}
		if (mediaSource.readyState === 'open') {
			destroy('decode');
		}
	};
	var ready = false;
	var tracks = {}; // keyed by track id
	mp4box.onReady = function (info) {
		debug('MP4 info: %o', info);
		info.tracks.forEach(function (track) {
			var mime;
			if (track.video) {
				mime = 'video/mp4';
			} else if (track.audio) {
				mime = 'audio/mp4';
			} else {
				return;
			}
			mime += '; codecs="' + track.codec + '"';
			if (MediaSource.isTypeSupported(mime)) {
				var sourceBuffer = mediaSource.addSourceBuffer(mime);
				var trackEntry = {
					buffer: sourceBuffer,
					arrayBuffers: [],
					meta: track,
					ended: false
				};
				sourceBuffer.addEventListener('updateend', popBuffers.bind(null, trackEntry));
				mp4box.setSegmentOptions(track.id, null, {
					// It really isn't that inefficient to give the data to the browser on every frame (for video)
					nbSamples: track.video ? 1 : 100
				});
				tracks[track.id] = trackEntry
			}
		});

		if (Object.keys(tracks).length === 0) {
			destroy('decode');
			return;
		}

		var initSegs = mp4box.initializeSegmentation();
		initSegs.forEach(function (initSegment) {
			appendBuffer(tracks[initSegment.id], initSegment.buffer);
			if (initSegment.id === debugTrack) {
				save('init-track-' + debugTrack + '.mp4', [initSegment.buffer]);
				debugBuffers.push(initSegment.buffer);
			}
		});
		ready = true;
	};

	mp4box.onSegment = function (id, user, buffer, nextSample) {
		var track = tracks[id];
		appendBuffer(track, buffer, nextSample === track.meta.nb_samples);
		if (id === debugTrack && debugBuffers) {
			debugBuffers.push(buffer);
			if (nextSample > 1000) {
				save('track-' + debugTrack + '.mp4', debugBuffers);
				debugBuffers = null;
			}
		}
	};

	var requestOffset; // Position in the file where `stream` will next provide data
	var stream = null;
	var detachStream = null;
	function makeRequest (pos) {
		if (pos === file.length) {
			mp4box.flush(); // All done!
			return;
		}

		if (stream && pos === requestOffset) {
			var toResume = stream;
			// Resume on the next tick
			setTimeout(function () {
				if (stream === toResume)
					stream.resume();
			});
			return; // There is already a stream at the right position, so just let it continue
		}

		if (stream) {
			stream.destroy(); // There is a stream, but not at the right position
			detachStream();
		}

		requestOffset = pos;
		var opts = {
			start: requestOffset,
			end: file.length - 1
		};
		// There is necessarily only one stream that is not detached/destroyed at one time,
		// so it's safe to overwrite the var from the outer scope
		stream = file.createReadStream(opts);
		function onData (data) {
			// Pause the stream and resume it on the next run of the event loop to avoid
			// lots of 'data' event blocking the UI
			stream.pause();

			var arrayBuffer = new Buffer(data).buffer; // TODO: avoid copy
			arrayBuffer.fileStart = requestOffset;
			requestOffset += arrayBuffer.byteLength;
			var nextOffset;
			try {
				// MP4Box tends to blow up ungracefully when it can't parse the mp4 input, so
				// use a try/catch
				nextOffset = mp4box.appendBuffer(arrayBuffer);
				// // Prevent infinte loops if mp4box keeps requesting the same data
				// if (nextOffset === arrayBuffer.fileStart) {
				// 	throw new Error('MP4Box parsing stuck at offset: ' + nextOffset);
				// }
			} catch (err) {
				debug('MP4Box threw exception: %s', err.message);
				// This will fire the 'error' event on the audio/video element
				if (mediaSource.readyState === 'open') {
					destroy('decode');
				}
				stream.destroy();
				detachStream();
				return;
			}
			makeRequest(nextOffset);
		}
		stream.on('data', onData);
		function onEnd () {
			detachStream();
			makeRequest(requestOffset);
		}
		stream.on('end', onEnd);
		function onStreamError (err) {
			debug('Stream error: %s', err.message);
			if (mediaSource.readyState === 'open') {
				destroy('network');
			}
		}
		stream.on('error', onStreamError);

		detachStream = function () {
			stream.removeListener('data', onData);
			stream.removeListener('end', onEnd);
			stream.removeListener('error', onStreamError);
			stream = null;
			detachStream = null;
		}
	}

	function onWaiting () {
		if (ready) {
			seek(mediaElem.currentTime);
		}
	}

	function seek (seconds) {
		if (destroyed)
			init();

		var seekResult = mp4box.seek(seconds, true);
		debug('Seeking to time: %d', seconds);
		debug('Seeked file offset: %d', seekResult.offset);
		makeRequest(seekResult.offset);
	}

	function appendBuffer (track, buffer, ended) {
		track.arrayBuffers.push({
			buffer: buffer,
			ended: ended || false
		});
		popBuffers(track);
	}

	// Potentially call popBuffers() again. Call this whenever
	// the buffer may have become less full (i.e. on timeupdate)
	function onTimeUpdate () {
		Object.keys(tracks).forEach(function (id) {
			var track = tracks[id];
			if (track.blocked) {
				popBuffers(track);
			}
		});
	}

	function popBuffers (track) {
		if (track.buffer.updating)
			return;

		track.blocked = !shouldAppend(track);
		if (track.blocked)
			return;

		if (track.arrayBuffers.length === 0)
			return;
		var buffer = track.arrayBuffers.shift();
		var appended = false;
		try {
			track.buffer.appendBuffer(buffer.buffer);
			track.ended = buffer.ended;
			appended = true;
		} catch (err) {
			debug('SourceBuffer error: %s', err.message);
			destroy('decode');
			return;
		}
		if (appended) {
			updateEnded(); // call mediaSource.endOfStream() if needed
		}
	}

	function updateEnded () {
		if (mediaSource.readyState !== 'open') {
			return;
		}

		var ended = Object.keys(tracks).every(function (id) {
			var track = tracks[id];
			return track.ended && !track.buffer.updating;
		});

		if (ended) {
			destroy();
		}
	}
};

/**
  Saves an array of ArrayBuffers to the given filename.
  @param {string} filename Filename to save as.
  @param {Array.<ArrayBuffer>}
  */
function save (filename, buffers) {
	var blob = new Blob(buffers);
	var url = URL.createObjectURL(blob);
	var a = document.createElement('a');
	a.setAttribute('href', url);
	a.setAttribute('download', filename);
	a.click();
 }
