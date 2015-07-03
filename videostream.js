var debug = require('debug')();
var MP4Box = require('mp4box');

var HIGH_WATER_MARK = 10000000; // 1MB
var LOW_WATER_MARK = 1000000; // 100kB
var APPEND_RETRY_TIME = 5000; // seconds

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
	mediaElem.addEventListener('waiting', function () {
		if (ready) {
			seek(mediaElem.currentTime);
		}
	});

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
			mediaSource.endOfStream('decode');
		}
	};
	var ready = false;
	var totalWaitingBytes = 0;
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
			mediaSource.endOfStream('decode');
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
			// Only resume if there isn't too much data that mp4box has processed that hasn't
			// gone to the browser
			if (totalWaitingBytes <= HIGH_WATER_MARK) {
				resumeStream();
			}

			var arrayBuffer = data.toArrayBuffer(); // TODO: avoid copy
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
					mediaSource.endOfStream('decode');
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
				mediaSource.endOfStream('network');
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

	function seek (seconds) {
		var seekResult = mp4box.seek(seconds, true);
		debug('Seeking to time: %d', seconds);
		debug('Seeked file offset: %d', seekResult.offset);
		makeRequest(seekResult.offset);
		resumeStream();
	}

	function appendBuffer (track, buffer, ended) {
		totalWaitingBytes += buffer.byteLength;
		track.arrayBuffers.push({
			buffer: buffer,
			ended: ended || false
		});
		popBuffers(track);
	}

	function popBuffers (track) {
		if (track.buffer.updating || track.arrayBuffers.length === 0) return;
		var buffer = track.arrayBuffers.shift();
		var appended = false;
		try {
			track.buffer.appendBuffer(buffer.buffer);
			track.ended = buffer.ended;
			appended = true;
		} catch (err) {
			debug('SourceBuffer error: %s', err.message);
			// Wait and try again later (assuming buffer space was the issue)
			track.arrayBuffers.unshift(buffer);
			setTimeout(function () {
				popBuffers(track);
			}, APPEND_RETRY_TIME);
		}
		if (appended) {
			totalWaitingBytes -= buffer.buffer.byteLength;
			if (totalWaitingBytes <= LOW_WATER_MARK) {
				resumeStream();
			}
			updateEnded(); // call mediaSource.endOfStream() if needed
		}
	}

	function resumeStream () {
		// Always wait till the next run of the event loop to cause async break
		setTimeout(function () {
			if (stream) {
				// TODO: remove stream._readableState.flowing once stream.isPaused is available
				if (stream.isPaused ? stream.isPaused() : !stream._readableState.flowing) {
					stream.resume();
				}
			}
		});
	}

	function updateEnded () {
		if (mediaSource.readyState !== 'open') {
			return;
		}

		var ended = Object.keys(tracks).every(function (id) {
			var track = tracks[id];
			return track.ended && !track.buffer.updating;
		});

		if (ended && mediaSource.readyState === 'open') {
			mediaSource.endOfStream();
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
