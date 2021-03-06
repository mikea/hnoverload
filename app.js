// run debug: DEBUG=hnoverload:* npm start

const express = require('express');
const path = require('path');
const favicon = require('serve-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const _ = require('underscore');
const Rx = require('rx');
const rss = require('node-rss');

const routes = require('./routes/index');
const users = require('./routes/users');
const Firebase = require("firebase");
const http = require("http");
const RxFirebase = require("./shared/rxfirebase");
const Instrument = require("./shared/instrument");
const request = require("request")

const app = express();

const DEV = app.get('env') === 'development';

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
app.use('/weekly', express.static(path.join(__dirname, 'public/weekly.html')));

// app.use('/', routes);
app.use('/users', users);

app.get('/ping', function(req, res) {
    res.send('pong');
});

var hnfb = new RxFirebase(new Firebase("https://hacker-news.firebaseio.com/v0/"));

var firebaseURL = DEV ? "https://hnoverload-dev.firebaseio.com" : "https://sweltering-heat-9449.firebaseio.com";
var firebase = new Firebase(firebaseURL);
var rxfb = new RxFirebase(firebase);

var instrument = new Instrument("/mike/hnoverload", process.env.instrument_url);

var mercuryKey = process.env.mercury_key;
if (!mercuryKey) {
    throw new Error("mercury_key env variable not defined");
} else {
    console.info("Using mercuryKey", mercuryKey);
}

app.get('/rss', function(req, res) {
    var feed = rss.createNewFeed('HN Overload', 'https://hnoverload.herokuapp.com/',
        'Daily Top 10 HackerNews Posts',
        '',
        'https://hnoverload.herokuapp.com/rss', {});

    res.set('Content-Type', 'application/rss+xml');
    instrument.increment("/get", {
        "url": "/rss"
    });
    rxfb.child("dates")
        .limitToLast(11)
        .once("value")
        .map(function(snapshot) {
            return snapshot.val();
        })
        .flatMap(function(dates) {
            return _.chain(dates).keys().reverse().value();
        })
        .skip(1) // skip today
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
                var description = "<h1>Score: " + item.score +
                    "&nbsp;Comments: <a href=\"" + hnlink + "\">" + (item.descendants || 0) + "</a></h1>";

                if (_.has(item, "readability") && _.has(item.readability, "content")) {
                  description += item.readability.content;
                }

                var item = {
                    title: item.title,
                    link: item.url || hnlink,
                    pubDate: new Date(item.time * 1000).toUTCString(),
                    description: description,
                    guid: hnlink,
                    "dc:creator": item.by
                };
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

// Firebase.enableLogging(true);

function logError(error) {
    console.log("*** UNHANDLED ERROR", error);
}

function loggingObserver(prefix) {
    return Rx.Observer.create(
        function(x) {
            console.log(prefix, 'Do Next: ', x);
        },
        function(err) {
            console.log(prefix, 'Do Error: ', err);
        },
        function() {
            console.log(prefix, 'Do Completed');
        }
    );

}

function rxHttpRequest(options) {
    return Rx.Observable.create(observer => {
        const cb = (error, response, body) => {
            if (error) {
                observer.onError(error);
                return;
            }
            observer.onNext(body);
            observer.onCompleted();
        };
        request(options, cb);
    });

}

function updateStory(storyId) {
    instrument.increment("/tasks", {
        "task": "updateStory"
    });

    return hnfb
        .child("item/" + storyId)
        .once("value")
        .map(snapshot => {
            if (!snapshot.exists()) {
                console.log("null story ", storyId);
                throw new Error("null story");
            }
            return snapshot.val();
        })
        .map(story => {
             if (!_.has(story, "time")) {
                instrument.increment("/errors", {
                    "error": "story-time-not-defined"
                });
                throw new Error("time is not defined");
            }

            var item_location = "story_by_date/" + new Date(story.time * 1000).toISOString().substring(0, 10) + "/" + storyId;

            if (_.has(story, "parent")) {
                instrument.increment("/events", {
                    "event": "ignore-child-story"
                });
                return story;
            }

            if (_.has(story, "deleted") && story.deleted) {
                instrument.increment("/events", {
                    "event": "story-deleted"
                });
                firebase.child(item_location).remove();
                return story;
            }

            console.log("***", item_location);
            rxfb.child(item_location)
                .once("value")
                .map(snapshot => snapshot.val() || {})
                .map(oldStory => _.extend(oldStory, story))
                .map(story => _.omit(story, "kids"))
                .flatMap(story => {
                    if (story.readability || (story.score || 0) < 50) {
                        return [story];
                    }
                    console.log("fetching readability", story.id);
                    return rxHttpRequest({
                        url: "https://mercury.postlight.com/parser?url=" + encodeURIComponent(story.url),
                        json: true,
                        headers: {
                            'x-api-key': encodeURIComponent(mercuryKey)
                        }})
                        .map(response => _.extend(story, {"readability": response}));
                })
                .forEach(story => {
                    firebase.child(item_location).set(story);

                    // bump max item id
                    instrument.increment("/events", {
                        "event": "story-update"
                    });
                    firebase.child("maxitem").transaction(currentValue => {
                        currentValue = currentValue || storyId;
                        return currentValue < storyId ? storyId : currentValue;
                    });
                });

            return story;
        });
}

function scheduleTask(name, payload, fn) {
    return rxfb
        .child("tasks")
        .push({
            name: name,
            payload: payload,
            fn: fn.toString(),
        });
}

function executeTask(key, task) {
    return Rx.Observable
        .just(task)
        .map(function(task) {
            instrument.increment("/tasks", {
                "task": task.name
            });
            return task;
        })
        .flatMap(function(task) {
            try {
                var payload = task.payload;
                var fn = eval("(" + task.fn + ")");
                var observable = fn(payload) || Rx.Observable.empty();
                return observable;
            } catch (e) {
                return Rx.Observable.throw(e);
            }
        })
        .doOnCompleted(function() {
            firebase.child("tasks")
                .child(key)
                .remove();
        })
        .doOnError(function(e) {
            firebase.child("tasks")
                .child(key)
                .transaction(function(task) {
                    task.errors = (task.errors || 0) + 1;
                    task.last_error = "" + e;
                    task.last_attempt = new Date().getTime() / 1000;
                    return task;
                });
        })
        .onErrorResumeNext(Rx.Observable.empty());
}

rxfb.child("tasks")
    .on("child_added")
    .map(function(snapshot) {
        return [snapshot.key(), snapshot.val()];
    })
    .filter(function(tuple) {
        return !tuple[1].errors;
    })
    .concatMap(function(tuple) {
        return executeTask(tuple[0], tuple[1]);
    })
    .subscribe();


function retryErrorTasks() {
    return rxfb.child("tasks")
        .once("value")
        .flatMap(function(snapshot) {
            return _.pairs(snapshot.val());
        })
        .filter(function(tuple) {
            return tuple[1].errors > 0;
        })
        .flatMap(function(tuple) {
            var key = tuple[0];
            var task = tuple[1];

            if (task.errors < 10) {
                return executeTask(key, task);
            } else {
                return Rx.Observable.concat(
                    rxfb.child("error_tasks/" + key).set(task),
                    rxfb.child("tasks/" + key).remove()
                );
            }
        });
}


function watchNewStories(minStoryId) {
    var lastStoryId = minStoryId;

    hnfb.child("maxitem")
        .on("value")
        .forEach(function(snapshot) {
            instrument.increment("/events", {
                "event": "maxitem.value"
            });
            var maxId = snapshot.val();
            console.log("new maxvalue: ", maxId, lastStoryId);
            if (lastStoryId) {
                Rx.Observable
                    .range(lastStoryId + 1, maxId - lastStoryId)
                    .concatMap(function(idx) {
                        return scheduleTask("updateStory", {
                            id: idx,
                            tag: "watchNewStories"
                        }, function(payload) {
                            return updateStory(payload.id);
                        });

                    })
                    .subscribe();
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

    return rxfb
        .child("story_by_date/" + date)
        .once("value")
        .filter(snapshot => snapshot.val())
        .flatMap(snapshot=> Object.keys(snapshot.val()))
        .flatMap(id =>  scheduleTask("updateStory",
                                     { id: id, tag: "updateDate" },
                                     payload =>  updateStory(payload.id))
        );
}

function updateDateRange(from, to) {
    var d = new Date();
    d.setHours(0, 0, 0);

    return Rx.Observable
        .range(from, to - from)
        .flatMap(dist => {
            var oldDate = new Date(d);
            oldDate.setDate(d.getDate() - dist);
            return updateDate(oldDate.toISOString().substring(0, 10));
        });
}

function every15min() {
    instrument.increment("/lifecycle", {
        "event": "cron15m"
    });
    console.log("*** every15min");
    return updateDateRange(0, 1);
}

function every1hr() {
    instrument.increment("/lifecycle", {
        "event": "cron1h"
    });
    console.log("*** every1hr");
    return updateDateRange(1, 7);
}

rxfb.child("maxitem")
    .once("value")
    .map(snapshot =>  snapshot.val() /* || 9700000*/)
    .doOnError(logError)
    .subscribeOnNext(maxid => {
        console.log("watching stories from " + maxid);
        watchNewStories(maxid);
    });

Rx.Observable
    .interval(1000 * 60 * 1)
    .flatMap(() => scheduleTask("retryErrorTasks", {}, retryErrorTasks))
    .subscribe();

Rx.Observable
    .interval(1000 * 60 * 15)
    .flatMap(() => scheduleTask("every15min", {}, every15min))
    .subscribe();

Rx.Observable
    .interval(1000 * 60 * 60)
    .flatMap(() =>  scheduleTask("every1hr", {}, every1hr))
    .subscribe();

instrument.increment("/lifecycle", {
    "event": "start"
});

module.exports = app;

console.log("Application started with ", firebaseURL, "environment: " + app.get('env'));

// updateStory(9981805).subscribe();
