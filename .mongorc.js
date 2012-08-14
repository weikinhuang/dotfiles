// generate a MONGO_PS1 DB_STATE#host[dbname]> 
(function() {
	"use strict";
	var states = [ "STARTUP", "PRIMARY", "SECONDARY", "RECOVERING", "FATAL", "STARTUP2", "UNKNOWN", "ARBITER", "DOWN", "ROLLBACK" ];
	var host = db.serverStatus().host;

	prompt = function() {
		var dbState, status = "", dbStatus = db.isMaster();
		if (dbStatus.setName) {
			if (dbStatus.ismaster) {
				dbState = 'PRIMARY';
			} else if (dbStatus.secondary) {
				dbState = 'SECONDARY';
			} else {
				dbState = states[rs.status().myState];
			}
			if(dbStatus.hidden) {
				dbState = dbState.toLowerCase();
			}
			status = dbState + ":[" + dbStatus.setName + "]#";
		}
		return status + host + "[" + db + "]> ";
	};
})();

// always enable pretty print
DBQuery.prototype._prettyShell = true;
