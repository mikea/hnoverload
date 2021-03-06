'use strict';

(function(window) {
    var isInNode = typeof module === 'object' && module && typeof module.exports === 'object';
    var Rx = isInNode ? require("rx") : window.Rx;

    var RxFirebase = function(firebase) {
        this.fb = firebase;
    };

    RxFirebase.prototype.child = function(path) {
        return new RxFirebase(this.fb.child(path));
    };

    RxFirebase.prototype.once = function(eventType) {
        var self = this;

        return Rx.Observable.create(function(observer) {
            var cb = function(data) {
                try {
                    observer.onNext(data);
                } catch (e) {
                    console.error("*** UNHANDLED error in onnext: ", e);
                    if (e.stack) {
                      console.error(e.stack);
                    }
                    throw e;
                }
                observer.onCompleted();
            };
            var ecb = function(error) {
                observer.onError(error);
            };

            self.fb.once(eventType, cb, ecb);

            return Rx.Disposable.create(function() {
                self.fb.off(eventType, cb);
            });
        });
    };

    RxFirebase.prototype.on = function(eventType) {
        var self = this;
        return Rx.Observable.create(function(observer) {
            var cb = function(data) {
                try {
                    observer.onNext(data);
                } catch (e) {
                    console.error("*** UNHANDLED error in onnext: ", e);
                    if (e.stack) {
                      console.error(e.stack);
                    }
                    throw e;
                }
            };
            var ecb = function(data) {
                observer.onError(data);
            };
            self.fb.on(eventType, cb, ecb);

            return Rx.Disposable.create(function() {
                self.fb.off(eventType, cb);
            });
        });
    };

    RxFirebase.prototype.limitToLast = function(limit) {
        return new RxFirebase(this.fb.limitToLast(limit));
    }

    RxFirebase.prototype.push = function(data) {
        var self = this;

        return Rx.Observable.create(function(observer) {
            var cb = function(error) {
                if (error) {
                    observer.onError(error);
                } else {
                    observer.onCompleted();
                }
            };
            self.fb.push(data, cb);
        });
    }

    RxFirebase.prototype.set = function(data) {
        var self = this;

        return Rx.Observable.create(function(observer) {
            var cb = function(error) {
                if (error) {
                    observer.onError(error);
                } else {
                    observer.onCompleted();
                }
            };
            self.fb.set(data, cb);
        });
    }

    RxFirebase.prototype.remove = function() {
        var self = this;

        return Rx.Observable.create(function(observer) {
            var cb = function(error) {
                if (error) {
                    observer.onError(error);
                } else {
                    observer.onCompleted();
                }
            };
            self.fb.remove(cb);
        });
    }

    if (isInNode) {
        module.exports = RxFirebase;
    } else {
        window.RxFirebase = RxFirebase;
    }
})(this);
