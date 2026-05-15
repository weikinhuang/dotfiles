// Generate a MONGO_PS1 DB_STATE#host[dbname]> prompt for mongosh.
(function () {
  'use strict';

  var states = {
    0: 'STARTUP',
    1: 'PRIMARY',
    2: 'SECONDARY',
    3: 'RECOVERING',
    4: 'FATAL',
    5: 'STARTUP2',
    6: 'UNKNOWN',
    7: 'ARBITER',
    8: 'DOWN',
    9: 'ROLLBACK',
  };

  function getHost() {
    try {
      return db.serverStatus().host;
    } catch {
      return '';
    }
  }

  function getHello() {
    try {
      return db.hello();
    } catch {
      return {};
    }
  }

  function getReplicaSetState(hello) {
    var state;
    if (!hello.setName) {
      return '';
    }

    if (hello.isWritablePrimary) {
      state = 'PRIMARY';
    } else if (hello.secondary) {
      state = 'SECONDARY';
    } else {
      try {
        state = states[rs.status().myState] || 'UNKNOWN';
      } catch {
        state = 'UNKNOWN';
      }
    }

    if (hello.hidden) {
      state = state.toLowerCase();
    }

    return state + ':[' + hello.setName + ']#';
  }

  prompt = function () {
    if (typeof db === 'undefined') {
      return '> ';
    }

    var hello = getHello();
    return getReplicaSetState(hello) + getHost() + ' [' + db.getName() + ']> ';
  };
})();
