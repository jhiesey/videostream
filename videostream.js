var MP4Box = require('mp4box');

/**
 * Stream data from `file` into `video`.
 * `file` must be an object with a `length` property giving the file size in bytes,
 * and a `createReadStream(opts)` method that retunr a string and accepts opts.start
 * and opts.end to specify a byte range (inclusive) to fetch.
 * @param {File} file described above
 * @param {HTMLVideoElement} video
 * @param {Object} opts Options
 * @param {number=} opts.debugTrack Track to save for debugging. Defaults to -1 (none)
 */
module.exports = function (file, video, opts) {
	opts = opts || {};
	var debugTrack = opts.debugTrack || 1;
	video.addEventListener('waiting', function () {
		if (ready) {
			seek(video.currentTime);
		}
	});

	var mediaSource = new MediaSource();
	mediaSource.addEventListener('sourceopen', function () {
		makeRequest(0);
	});
	video.src = window.URL.createObjectURL(mediaSource);

	var mp4box = new MP4Box();
	mp4box.onError = function (e) {
		console.error('MP4Box error:', e);
		mediaSource.endOfStream('decode');
	};
	var ready = false;
	var tracks = {}; // keyed by track id
	mp4box.onReady = function (info) {
		console.log('MP4 info:', info);
		info.tracks.forEach(function (track) {
			var mime = 'video/mp4; codecs="' + track.codec + '"';
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
					nbSamples: 500
				});
				tracks[track.id] = trackEntry
			}
		});

		var initSegs = mp4box.initializeSegmentation();
		initSegs.forEach(function (initSegment) {
			appendBuffer(tracks[initSegment.id], initSegment.buffer);
			if (initSegment.id === debugTrack) {
				save('init-track-' + debugTrack + '.mp4', [initSegment.buffer]);
			}
		});
		ready = true;
	};

	mp4box.onSegment = function (id, user, buffer, nextSample) {
		var track = tracks[id];
		appendBuffer(track, buffer, nextSample === track.meta.nb_samples);
		if (id === debugTrack) {
			save('buffer-' + debugTrack + '.mp4', [buffer]);
		}
	};

	var requestOffset; // Position in the file where `stream` will next provide data
	var stream = null;
	var detachStream;
	function makeRequest (pos) {
		if (pos === file.length) {
			mp4box.flush(); // All done!
			return;
		}

		if (stream && pos === requestOffset) {
			return; // There is already a stream at the right position, so just let it continue
		}

		if (stream) {
			detachStream();
			stream.destroy(); // There is a stream, but not at the right position
		}

		requestOffset = pos;
		var opts = {
			start: requestOffset,
			end: file.length - 1
		};
		var currStream = stream = file.createReadStream(opts);
		function onData (data) {
			var arrayBuffer = data.toArrayBuffer(); // TODO: avoid copy
			arrayBuffer.fileStart = requestOffset;
			requestOffset += arrayBuffer.byteLength;
			var nextOffset = mp4box.appendBuffer(arrayBuffer);
			makeRequest(nextOffset);
		}
		currStream.on('data', onData);
		function onEnd () {
			detachStream();
			stream = null;
			makeRequest(requestOffset);
		}
		currStream.on('end', onEnd);
		function onError (err) {
			console.error('Stream error:', err);
			mediaSource.endOfStream('network');
		}
		currStream.on('error', onError);

		detachStream = function () {
			currStream.removeListener('data', onData);
			currStream.removeListener('end', onEnd);
			currStream.removeListener('error', onError);
		}
	}

	function seek (seconds) {
		var seekResult = mp4box.seek(seconds, true);
		console.log('Seeking to time: ', seconds);
		console.log('Seeked file offset:', seekResult.offset);
		makeRequest(seekResult.offset);
	}

	function appendBuffer (track, buffer, ended) {
		track.arrayBuffers.push({
			buffer: buffer,
			ended: ended || false
		});
		popBuffers(track);
	}

	function popBuffers (track) {
		updateEnded(); // set call endOfStream() if needed
		if (track.buffer.updating || track.arrayBuffers.length === 0) return;
		var buffer = track.arrayBuffers.shift();
		try {
			track.buffer.appendBuffer(buffer.buffer);
			track.ended = buffer.ended;
		} catch (e) {
			console.error('SourceBuffer error: ', e);
			// TODO: what to do? for now try again later (if buffer space was the issue)
			track.arrayBuffers.unshift(buffer);
		}
		updateEnded();
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
			mediaSource.endOfStream();
		}
	}
};
