/* Magic Mirror
 * Node Helper: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

var NodeHelper = require("node_helper");
var Https = require("https");
var unauthenticated_agent = new Https.Agent({
	rejectUnauthorized: false,
});
var fetch = require("node-fetch");
if (!globalThis.fetch) {
	globalThis.fetch = fetch;
}


module.exports = NodeHelper.create({

	start: function() {
		this.powerwallEndpoints = {};
		this.twcManagerEndpoints = {};
		this.teslaApiAccounts = {};
	},

	// Override socketNotificationReceived method.

	/* socketNotificationReceived(notification, payload)
	 * This method is called when a socket notification arrives.
	 *
	 * argument notification string - The identifier of the noitication.
	 * argument payload mixed - The payload of the notification.
	 */
	socketNotificationReceived: function(notification, payload) {
		
		let powerwallEndpoints = this.powerwallEndpoints;
		let twcManagerEndpoints = this.twcManagerEndpoints;
		var self = this;
		if (notification === "MMM-Powerwall-Configure-Powerwall") {
			let updateInterval = payload.updateInterval;
			let powerwallIP = payload.powerwallIP;
			let powerwallPassword = payload.powerwallPassword;

			if( powerwallEndpoints[powerwallIP] ) {
				powerwallEndpoints[powerwallIP].password = powerwallPassword;
				powerwallEndpoints[powerwallIP].updateInterval = Math.min(
					powerwallEndpoints[powerwallIP].updateInterval,
					updateInterval
				);
			}
			else {
				// First configuration for this Powerwall; update immediately
				powerwallEndpoints[powerwallIP] = {
					password: powerwallPassword,
					aggregates: null,
					lastUpdate: 0,
					updateInterval: updateInterval
				};
			}
		}
		else if (notification === "MMM-Powerwall-Configure-TWCManager") {
			console.log(payload);
			let ip = payload.twcManagerIP;
			if( twcManagerEndpoints[ip] ) {
				twcManagerEndpoints[ip].port = payload.port;
			}
			else {
				twcManagerEndpoints[ip] = {
					updateInterval: payload.updateInterval,
					status: null,
					port: payload.port,
					lastUpdate: 0
				}
			}
		}
		else if (notification === "MMM-Powerwall-UpdateLocal") {
			let ip = payload.powerwallIP;
			if( powerwallEndpoints[ip] ) {
				if( powerwallEndpoints[ip].lastUpdate + powerwallEndpoints[ip].updateInterval < Date.now() ) {
					self.updatePowerwall(ip, powerwallEndpoints[ip].password);
				}
				else {
					if (powerwallEndpoints[ip].aggregates) {
						this.sendSocketNotification("MMM-Powerwall-Aggregates", {
							ip: ip,
							aggregates: powerwallEndpoints[ip].aggregates
						});
					}	
				}
			}
			ip = payload.twcManagerIP
			if( ip && twcManagerEndpoints[ip] ) {
				if( twcManagerEndpoints[ip].lastUpdate + twcManagerEndpoints[ip].updateInterval < Date.now() ) {
					self.updateTWCManager(ip, twcManagerEndpoints[ip].port)
				}
				else {
					this.sendSocketNotification("MMM-Powerwall-ChargeStatus", {
						ip: ip,
						status: twcManagerEndpoints[ip].status
					});
				}
			}
		}
	},

	updatePowerwall: async function(powerwallIP, powerwallPassword) {
		this.powerwallEndpoints[powerwallIP].lastUpdate = Date.now();
		let url = "https://" + powerwallIP + "/api/meters/aggregates";
		let result = await fetch(url, {agent: unauthenticated_agent});

		if( result.ok ) {
			var aggregates = await result.json();
			this.powerwallEndpoints[powerwallIP].aggregates = aggregates;
			// Send notification
			this.sendSocketNotification("MMM-Powerwall-Aggregates", {
				ip: powerwallIP,
				aggregates: aggregates
			});
		}
		else {
			console.log("Powerwall fetch failed")
		}
	},

	updateTWCManager: async function(twcManagerIP) {
		this.twcManagerEndpoints[twcManagerIP].lastUpdate = Date.now();
		let port = this.twcManagerEndpoints[twcManagerIP].port;
		let url = "http://" + twcManagerIP + ":" + port + "/api/getStatus";
		console.log("Fetching from TWC at " + url); 
		let result = await fetch(url);

		if( result.ok ) {
			var status = await result.json();
			this.twcManagerEndpoints[twcManagerIP].status = status;
			// Send notification
			this.sendSocketNotification("MMM-Powerwall-ChargeStatus", {
				ip: twcManagerIP,
				status: status
			});
		}
		else {
			console.log("TWCManager fetch failed")
		}
	}
});
