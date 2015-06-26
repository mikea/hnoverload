// run debug: DEBUG=hnoverload:* npm start

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var _ = require('underscore');
var Rx = require('rx');
var rss = require('node-rss');

var routes = require('./routes/index');
var users = require('./routes/users');
var Firebase = require("firebase");
var RxFirebase = require("./shared/rxfirebase");
var Instrument = require("./shared/instrument");

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/bower_components', express.static(path.join(__dirname, 'bower_components')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// app.use('/', routes);
app.use('/users', users);

app.get('/ping', function(req, res) {
    res.send('pong');
});

var hnFirebase = new Firebase("https://hacker-news.firebaseio.com/v0/");
var rxhnfb = new RxFirebase(hnFirebase);

var firebase = new Firebase("https://sweltering-heat-9449.firebaseio.com");
var rxfb = new RxFirebase(firebase);

app.get('/rss', function(req, res) {
    var feed = rss.createNewFeed('HN Overload', 'https://hnoverload.herokuapp.com/',
        'Daily Top 10 HackerNews Posts',
        '',
        'https://hnoverload.herokuapp.com/rss', {});

    res.set('Content-Type', 'application/rss+xml');
    rxfb.child("dates")
        .limitToLast(11)
        .once("value")
        .map(function(snapshot) {
            return snapshot.val();
        })
        .flatMap(function(dates) {
            return _.chain(dates).keys().reverse().value();
        })
        .skip(1)  // skip today
        .flatMap(function(date) {
            return rxfb.child("story_by_date/" + date)
                .once("value")
                .flatMap(function(snapshot) {
                    var storiesMap = snapshot.val();
                    if (!storiesMap) {
                        return [];
                    }

                    var allStories = _.chain(storiesMap)
                        .keys()
                        .map(function(key) {
                            return storiesMap[key];
                        })
                        .filter(function(story) {
                            return !story.deleted;
                        })
                        .toArray()
                        .value();

                    var sortingFn = function(story) {
                        return -story.score;
                    };

                    return _.chain(allStories)
                        .sortBy(sortingFn)
                        .first(10)
                        .toArray()
                        .value();
                });
        })
        .forEach(
            function(item) {
                var hnlink = "https://news.ycombinator.com/item?id=" + item.id;
                var description = "<p>HN Score: " + item.score + "</p>" +
                    "<p>HN Comments: <a href=\"" + hnlink + (item.descendants || 0) + "\"></p>";

                var item = {
                    title: item.title,
                    link: item.url || hnlink,
                    pubDate: new Date(item.time * 1000).toUTCString(),
                    description: description,
                    guid: hnlink,
                    author: item.by
                };
                console.log(item);
                feed.items.push(item);
            },
            null,
            function() {
                res.send(rss.getFeedXML(feed));
            });

});

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

var instrument = new Instrument("/mike/hnoverload", process.env.instrument_url);

// Firebase.enableLogging(true);

function logError(error) {
    console.log("*** UNHANDLED ERROR", error);
}

function incError(storyId) {
    firebase.child("errors/" + storyId).transaction(function(currentValue) {
        return (currentValue || 0) + 1;
    });
}

function clearError(storyId) {
    firebase.child("errors/" + storyId).remove();
}


function updateStory(storyId) {
    instrument.increment("/tasks", {
        "task": "updateStory"
    });

    function _updateStory(story) {
        if (!story) {
            console.log("null story, scheduling retry: " + storyId);
            incError(storyId);
            setTimeout(updateStory, 10000, storyId);
            return;
        }

        if (!_.has(story, "time")) {
            instrument.increment("/errors", {
                "error": "story-time-not-defined"
            });
            incError(storyId);
            console.log("time is not defined: %j", story);
            // setTimeout(updateStory, 10000, storyId);
            return;
        }

        clearError(storyId);

        var item_location = "story_by_date/" + new Date(story.time * 1000).toISOString().substring(0, 10) + "/" + storyId;

        if (_.has(story, "parent")) {
            instrument.increment("/events", {
                "event": "ignore-child-story"
            });
            // console.log("ignoring child story: " + storyId);
            return;
        }

        if (_.has(story, "deleted") && story.deleted) {
            instrument.increment("/events", {
                "event": "story-deleted"
            });
            // console.log("deleting deleted story: " + storyId);
            firebase.child(item_location).remove();
            return;
        }

        // console.log("updating story " + storyId);

        firebase.child(item_location).set(story);

        // bump max item id  
        instrument.increment("/events", {
            "event": "story-update"
        });
        firebase.child("maxitem").transaction(function(currentValue) {
            currentValue = currentValue || storyId;
            return currentValue < storyId ? storyId : currentValue;
        });
    }

    rxfb.child("errors/" + storyId)
        .once("value")
        .map(function(snapshot) {
            return snapshot.val() || 0;
        })
        .filter(function(errorCount) {
            if (errorCount >= 10) {
                instrument.increment("/errors", {
                    "error": "story-abandoned-too-many-errors"
                });
                console.log("abandoning story, too many errors: " + storyId);
                return false;
            }

            return true;
        })
        // fetch story
        .flatMap(function(errorCount) {
            return rxhnfb.child("item/" + storyId).once("value");
        })
        // unwrap snapshot
        .map(function(snapshot) {
            return snapshot.val();
        })
        .doOnError(function(err) {
            instrument.increment("/errors", {
                "error": "story-unexpected-error"
            });
        })
        .onErrorResumeNext(Rx.Observable.empty())
        // update story
        .subscribeOnNext(function(story) {
            _updateStory(story);
        });
}

function watchNewStories(minStoryId) {
    var lastStoryId = minStoryId;

    hnFirebase.child("maxitem").on("value", function(snapshot) {
        instrument.increment("/events", {
            "event": "maxitem.value"
        });
        var maxId = snapshot.val();
        console.log("new maxvalue: " + maxId);
        for (var i = lastStoryId + 1; i <= maxId; i++) {
            setTimeout(updateStory, 10000, i);
        }
        lastStoryId = maxId;
    });
}

function updateDate(date) {
    instrument.increment("/tasks", {
        "task": "updateDate"
    });
    console.log("*** updating stories for " + date);
    firebase.child("dates/" + date).set(true);

    rxfb.child("story_by_date/" + date)
        .once("value")
        .filter(function(snapshot) {
            return snapshot.val();
        })
        .flatMap(function(snapshot) {
            return Object.keys(snapshot.val())
        })
        .forEach(updateStory);
}

function updateDateRange(from, to) {
    var d = new Date();
    d.setHours(0, 0, 0);

    for (var i = 0; i < to; i++, d.setDate(d.getDate() - 1)) {
        if (i >= from) {
            updateDate(d.toISOString().substring(0, 10));
        }
    }
}

function every15min() {
    instrument.increment("/lifecycle", {
        "event": "cron15m"
    });
    console.log("*** every15min");
    updateDateRange(0, 1);
}

function every1hr() {
    instrument.increment("/lifecycle", {
        "event": "cron1h"
    });
    console.log("*** every1hr");
    updateDateRange(1, 7);
}

setInterval(every15min, 1000 * 60 * 15);
every15min();
setInterval(every1hr, 1000 * 60 * 60);

rxfb.child("maxitem")
    .once("value")
    .map(function(snapshot) {
        return snapshot.val() || 9600000;
    })
    .doOnError(logError)
    .subscribeOnNext(function(maxid) {
        watchNewStories(maxid);
    });

// for (var i = 9600000; i > 9600000 - 20000; i--) {
//   updateStory(i);
// }


instrument.increment("/lifecycle", {
    "event": "start"
});

module.exports = app;