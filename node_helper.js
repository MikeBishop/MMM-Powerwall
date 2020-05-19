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
		var self = this;
		if (notification === "MMM-Powerwall-Configure-Powerwall") {
			let updateInterval = payload.updateInterval;
			let powerwallIP = payload.powerwallIP;
			let powerwallPassword = payload.powerwallPassword;

			if( !powerwallEndpoints.hasOwnProperty(powerwallIP) ) {
				// First configuration for this Powerwall; update immediately
				powerwallEndpoints[powerwallIP] = {
					password: powerwallPassword,
					aggregates: null,
					lastUpdate: 0,
					updateInterval: updateInterval
				};
				self.updatePowerwall(powerwallIP, powerwallPassword);
			}
			else {
				if (powerwallEndpoints[powerwallIP].aggregates) {
					this.sendSocketNotification("MMM-Powerwall-Aggregates", {
						ip: powerwallIP,
						aggregates: powerwallEndpoints[powerwallIP].aggregates
					});
				}
				powerwallEndpoints[powerwallIP = powerwallPassword];
			}
		}
		else if (notification === "MMM-Powerwall-UpdateLocal") {
			for(ip in powerwallEndpoints) {
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
	}
});
