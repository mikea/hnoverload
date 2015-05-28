// run debug: DEBUG=hnoverload:* npm start

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var _ = require('underscore');
var Rx = require('rx');

var routes = require('./routes/index');
var users = require('./routes/users');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/bower_components', express.static(path.join(__dirname, 'bower_components')));

// app.use('/', routes);
app.use('/users', users);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: app.get('env') === 'development' ? err : {}
  });
});

app.get('/ping', function (req, res) {
  res.send('pong');
});


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

var Firebase = require("firebase");
// Firebase.enableLogging(true);

var hnFirebase = new Firebase("https://hacker-news.firebaseio.com/v0/");
var rxhnfb = new RxFirebase(hnFirebase);

var firebase = new Firebase("https://sweltering-heat-9449.firebaseio.com");
var rxfb = new RxFirebase(firebase);

function logError(error) {
  console.log("*** UNHANDLED ERROR", error);
}

function incError(storyId) {
  firebase.child("errors/" + storyId).transaction(function (currentValue) {
    return (currentValue || 0) + 1;
  });
}

function clearError(storyId) {
  firebase.child("errors/" + storyId).remove();
}


function updateStory(storyId) {
  function _updateStory(itemSnapshot) {
        var story = itemSnapshot.val();
        if (!story) {
          console.log("null story, scheduling retry: " + storyId);
          incError(storyId);
          setTimeout(updateStory, 10000, storyId);
          return;
        }
  
        if (!_.has(story, "time")) {
          incError(storyId);
          console.log("time is not defined: %j", story);
          // setTimeout(updateStory, 10000, storyId);
          return;
        }
  
        clearError(storyId);
  
        if (_.has(story, "parent")) {
          console.log("ignoring child story: " + storyId);
          return;
        }
  
        console.log("updating story " + storyId);
  
        var item_location = "story_by_date/" + new Date(story.time * 1000).toISOString().substring(0, 10) + "/" + storyId;
        firebase.child(item_location).set(story);
  
        // bump max item id  
        firebase.child("maxitem").transaction(function (currentValue) {
          currentValue = currentValue || storyId;
          return currentValue < storyId ? storyId : currentValue;
        });
  }

  rxfb.child("errors/" + storyId)
      .once("value")
      .map(function(snapshot) { return snapshot.val() || 0;})
      .filter(function (errorCount) {
        if (errorCount >= 10) {
          console.log("abandoning story, too many errors: " + storyId); 
          return false;
        } 
        
        return true;
      })
      .flatMap(function (errorCount) { 
        return rxhnfb.child("item/" + storyId).once("value"); 
      })
      .doOnError(function (err) { console.log("@@@@@@@@@@ " + storyId + " " + err); })
      .onErrorResumeNext(Rx.Observable.empty())
      .subscribeOnNext(function (itemSnapshot) { 
        _updateStory(itemSnapshot);
      });
}

function watchNewStories(minStoryId) {
  var lastStoryId = minStoryId;
  
  hnFirebase.child("maxitem").on("value", function(snapshot) {
    var maxId = snapshot.val();
    console.log("new maxvalue: " + maxId);
    for (var i = lastStoryId + 1; i <= maxId; i++) {
      setTimeout(updateStory, 10000, i);
      // updateStory(i);
    }
    lastStoryId = maxId;
  });
}

function updateDate(date) {
  console.log("*** updating stories for " + date);
  firebase.child("story_by_date/" + date).once("value", function(snapshot) {
    Object.keys(snapshot.val()).forEach(function(storyId) {
      updateStory(storyId);
    });
  });
}

function every15min() {
  console.log("*** every15min");
  var today = new Date().toISOString().substring(0, 10);
  updateDate(today);
}

setInterval(every15min, 1000 * 60 * 15);
every15min()

rxfb.child("maxitem").once("value")
  .map(function (snapshot) { return snapshot.val() || 9600000;})
  .doOnError(logError)
  .subscribeOnNext(function(maxid) {watchNewStories(maxid); });

module.exports = app;
