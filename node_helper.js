/* Magic Mirror
 * Node Helper: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

var NodeHelper = require("node_helper");
var fs = require("fs").promises;
var Https = require("https");
var unauthenticated_agent = new Https.Agent({
	rejectUnauthorized: false,
});
var fetch = require("node-fetch");


module.exports = NodeHelper.create({

	start: function() {
		this.powerwallEndpoints = {};
		this.twcManagerEndpoints = {};
		this.teslaApiAccounts = {};
		this.energy = {};
		this.siteIds = {};
		this.filenames = [];
		this.lastUpdate = 0;
	},

	// Override socketNotificationReceived method.

	/* socketNotificationReceived(notification, payload)
	 * This method is called when a socket notification arrives.
	 *
	 * argument notification string - The identifier of the noitication.
	 * argument payload mixed - The payload of the notification.
	 */
	socketNotificationReceived: async function(notification, payload) {
		
		let powerwallEndpoints = this.powerwallEndpoints;
		let twcManagerEndpoints = this.twcManagerEndpoints;
		var self = this;

		this.log(notification + JSON.stringify(payload));

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
		else if (notification === "MMM-Powerwall-Configure-TeslaAPI") {
			let username = payload.teslaAPIUsername;
			let password = payload.teslaAPIPassword;
			let filename = payload.tokenFile;
			let siteId = payload.siteID;

			if( !this.filenames.includes(filename) ) {
				this.filenames.push(filename)
			}

			if( !this.siteIds[username] ) {
				this.siteIds[username] = [];
			}

			if( siteId && !this.siteIds[username].includes(siteId) ) {
				this.siteIds[username].push(siteId);
			}

			if( !this.teslaApiAccounts[username] ) {
				try {
					let fileContent = JSON.parse(
						await fs.readFile(filename)
					);
					this.teslaApiAccounts =  {
						...this.teslaApiAccounts,
						...fileContent
					};
					this.log("Read Tesla API tokens from file");
					this.log(JSON.stringify(this.teslaApiAccounts));
					await self.doTeslaApiTokenUpdate();
				}
				catch(e) {
					if( password ) {
						self.doTeslaApiLogin(username,password, filename);
					}
					else {
						this.log("Missing both Tesla password and access tokens");
					}
				}
			}
			if( !siteId ) {
				this.log("Attempting to infer siteID");
				siteId = await this.inferSiteID(username);
			}
			this.log("Found siteID " + siteId);

			this.sendSocketNotification("MMM-Powerwall-TeslaAPIConfigured", {
				username: username,
				siteID: siteId
			});
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
						this.sendSocketNotification("MMM-Powerwall-SOE", {
							ip: ip,
							soe: powerwallEndpoints[ip].soe
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
		else if (notification === "MMM-Powerwall-UpdateEnergy") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( !siteID ) {
				let siteID = await this.inferSiteID(username);
			}
			if( !this.energy[username] ) {
				this.energy[username] = {}
			}
			if( !this.energy[username][siteID] ) {
				this.energy[username][siteID] = {
					lastUpdate: 0,
					lastResult: null
				};
			}

			this.log([this.energy[username][siteID].lastUpdate,payload.updateInterval, Date.now()].join());
			if( this.energy[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				self.doTeslaApiGetEnergy(username, siteID);
			}
			else {
				this.sendSocketNotification("MMM-Powerwall-EnergyData", {
					username: username,
					siteID: siteID,
					energy: this.energy[username][siteID].lastResult
				});
			}
		}
	},

	updatePowerwall: async function(powerwallIP, powerwallPassword) {
		this.powerwallEndpoints[powerwallIP].lastUpdate = Date.now();
		let url = "https://" + powerwallIP + "/api/meters/aggregates";
		let result = await fetch(url, {agent: unauthenticated_agent});

		if( !result.ok ) {
			this.log("Powerwall fetch failed")
			return
		}

		var aggregates = await result.json();
		this.powerwallEndpoints[powerwallIP].aggregates = aggregates;
		// Send notification
		this.sendSocketNotification("MMM-Powerwall-Aggregates", {
			ip: powerwallIP,
			aggregates: aggregates
		});

		url = "https://192.168.200.41/api/system_status/soe";
		result = await fetch(url, {agent: unauthenticated_agent});

		if( !result.ok ) {
			this.log("Powerwall SOE fetch failed");
			return;
		}

		var response = await result.json();
		this.powerwallEndpoints[powerwallIP].soe = response.percentage;
		this.sendSocketNotification("MMM-Powerwall-SOE", {
			ip: powerwallIP,
			soe: response.percentage
		});
	},

	updateTWCManager: async function(twcManagerIP) {
		this.twcManagerEndpoints[twcManagerIP].lastUpdate = Date.now();
		let port = this.twcManagerEndpoints[twcManagerIP].port;
		let url = "http://" + twcManagerIP + ":" + port + "/api/getStatus";
		let success = true;
		try {
			var result = await fetch(url);
		}
		catch (e) {
			success = false;
		}

		if( success && result.ok ) {
			var status = await result.json();
			this.twcManagerEndpoints[twcManagerIP].status = status;
			// Send notification
			this.sendSocketNotification("MMM-Powerwall-ChargeStatus", {
				ip: twcManagerIP,
				status: status
			});
		}
		else {
			this.log("TWCManager fetch failed")
		}
	},

	doTeslaApiLogin: async function(username, password, filename) {
		url = "https://owner-api.teslamotors.com/oauth/token";
		let result = await fetch(url, {
			method: "POST",
			body: JSON.stringify({
				email: username,
				password: password,
				grant_type: "password",
				client_secret: "c7257eb71a564034f9419ee651c7d0e5f7aa6bfbd18bafb5c5c033b093bb2fa3",
				client_id: "81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384"
			}),
			headers: {
				"content-type": "application/json"
			}
		});

		if( !result.ok ) {
			return;
		}

		this.log("Got Tesla API tokens")
		this.teslaApiAccounts[username] = await result.json();
		await fs.writeFile(filename, JSON.stringify(this.teslaApiAccounts));
	},

	inferSiteID: async function(username) {
		url = "https://owner-api.teslamotors.com/api/1/products";

		if( !this.teslaApiAccounts[username] ) {
			this.log("Called inferSiteID() without credentials!")
			return null;
		}

		result = await fetch (url, {
			headers: {
				"Authorization": "Bearer " + this.teslaApiAccounts[username].access_token
			}
		});

		let response = (await result.json()).response;
		let siteIds = response.filter(product => (product.battery_type === "ac_powerwall")).map(product => product.energy_site_id);

		this.log(JSON.stringify(this.siteIds));
		if( this.siteIds[username].length === 0 ) {	
			if (siteIds.length === 1) {
				this.log("Inferred site ID " + siteIds[0]);
				this.siteIds[username].push(siteIds[0]);
				return siteIds[0];
			}
			else if (siteIds.length === 0) {
				this.log("Could not find Powerwall in your Tesla account");
			}
			else {
				this.log("Found multiple Powerwalls on your Tesla account:" + siteIds);
				this.log("Add 'siteID' to your config.js to specify which to target");
			}
		}
		else {
			if( !this.siteIds[username].every(id => siteIds.includes(id)) ) {
				this.log("Unknown site ID specified; found: " + siteIds);
			}
			else {
				return this.siteIds[username][0];
			}
		}
		return null;
	},

	log: function(message) {
		console.log("MMM-Powerwall: " + message);
	},

	doTeslaApiTokenUpdate: async function() {
		let anyUpdates = false;

		if( Date.now() < this.lastUpdate + 3600 ) {
			// Only check for expired tokens hourly
			return;
		}

		// We don't actually track which tokens came from which file.
		// If there are multiple, write all to all.
		for( const username in this.teslaApiAccounts ) {
			let tokens = this.teslaApiAccounts[username];
			if( (Date.now() / 1000) > tokens.created_at + (tokens.expires_in / 3)) {
				url = "https://owner-api.teslamotors.com/oauth/token";
				let result = await fetch(url, {
					method: "POST",
					body: JSON.stringify({
						email: username,
						grant_type: "refresh_token",
						client_secret: "c7257eb71a564034f9419ee651c7d0e5f7aa6bfbd18bafb5c5c033b093bb2fa3",
						client_id: "81527cff06843c8634fdc09e8ac0abefb46ac849f38fe1e431c2ef2106796384",
						refresh_token: tokens.refresh_token
					}),
					headers: {
						"content-type": "application/json",
					}
				});
		
				if( result.ok ) {
					this.log("Updated Tesla API token");
					anyUpdates = true;
					this.teslaApiAccounts[username] = await result.json();
				}
		
			}
		}

		if( anyUpdates ) {
			for( const filename of this.filenames ) {
				await fs.writeFile(filename, JSON.stringify(this.teslaApiAccounts));
			}
		}
	},

	doTeslaApiGetEnergy: async function(username, siteId) {
		this.log("GetEnergy called");
		
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteId + "/history?period=day&kind=energy";
		let result = {};
		try {
			this.log(url);
			result = await fetch(url, {
				headers: {
					"Authorization": "Bearer " + this.teslaApiAccounts[username].access_token
				}
			});
		}
		catch (e) {
			this.log(e);
			return;
		}

		if( result.ok ) {
			let json = await result.json();
			this.log(JSON.stringify(json));
			let response = json.response.time_series;
			if( !this.energy[username] ) {
				this.energy[username] = {};
			}
			this.log("Energy result: " + JSON.stringify(response));

			this.energy[username][siteId] = {
				lastUpdate: Date.now(),
				lastResult: response
			};
			this.sendSocketNotification("MMM-Powerwall-EnergyData", {
				username: username,
				siteID: siteId,
				energy: response
			});
		}
		else {
			this.log("Energy returned " + result.status);
			this.log(await result.text());
		}
		
	}
});
