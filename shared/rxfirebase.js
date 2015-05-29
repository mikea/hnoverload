'use strict';

(function(window){
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
      
      return Rx.Observable.create(function (observer) {
        self.fb.once(
          eventType, 
          function(data) { observer.onNext(data); observer.onCompleted(); },
          function(error) { observer.onError(error); }
        );  
      });
    };
    
    RxFirebase.prototype.on = function(eventType) {
      var self = this;
      return Rx.Observable.create(function (observer) {
        var cb = function(data) { observer.onNext(data); };
        var ecb = function(data) { observer.onError(data); };
        self.fb.on(eventType, cb,ecb);  
        return Rx.Disposable.create(function () {
          self.fb.off(eventType, cb);
        });
      });
    };

    if (isInNode) { module.exports = RxFirebase; } else { window.RxFirebase = RxFirebase; }  
})(this);