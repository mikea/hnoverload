var Rx = require("rx");

var source = Rx.Observable.range(0, 5)
  .flatMap(function (i) {
      // console.log("got i", i);
      return Rx.Observable.range(i, 2)
            .doOnCompleted(
                function () { console.log('Inner Do Completed'); }
                );
      ;
  })
  .doOnCompleted(
    function () { console.log('Do Completed'); }
  );

var subscription = source.subscribe(
  function (x) {
    console.log('Next: %s', x);
  },
  function (err) {
    console.log('Error: %s', err);
  },
  function () {
    console.log('Completed');
  });
