var Buffer = require('buffer').Buffer;

var onNextTick = function(cb) {
    setTimeout(cb, 0);
};

if (typeof requestIdleCallback !== 'undefined') {
    onNextTick = function(cb) {
        requestIdleCallback(function() { cb() });
    };
}

var utils = {
    debuglog: function(name) {
        if (d > 8) {
            var logger = MegaLogger.getLogger(name);

            return logger.debug.bind(logger);
        }

        return function() {};
    },
    nextTick: function() {
        var cb = arguments[0];

        if (arguments.length > 1) {
            arguments[0] = null;
            onNextTick(Function.prototype.bind.apply(cb, arguments));
        }
        else {
            onNextTick(cb);
        }
    },
    inherit: function(target, source) {
        target.prototype = Object.create(source && source.prototype || source);
        Object.defineProperty(target.prototype, 'constructor', {
            value: target,
            enumerable: false
        });
    },
    deprecate: function(cb, msg) {
        var warned = false;

        return function() {
            if (!warned) {
                warned = true;
                console.warn(msg);
            }
            return cb.apply(this, arguments);
        }
    },
    isU8: function(obj) {
        return obj instanceof Uint8Array || Buffer.isBuffer(obj);
    }
};

module.exports = utils;
