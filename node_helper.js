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
		this.powerwallAggregates = {};
		this.powerwallSOE = {};
		this.twcStatus = {};
		this.twcVINs = {};
		this.teslaApiAccounts = {};
		this.energy = {};
		this.selfConsumption = {};
		this.siteIDs = {};
		this.vehicles = {};
		this.driveState = {};
		this.chargeState = {};
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

		if (notification === "MMM-Powerwall-Configure-TeslaAPI") {
			let username = payload.teslaAPIUsername;
			let password = payload.teslaAPIPassword;
			let filename = payload.tokenFile;
			let siteID = payload.siteID;

			if( !this.filenames.includes(filename) ) {
				this.filenames.push(filename)
			}

			if( !this.siteIDs[username] ) {
				this.siteIDs[username] = [];
			}

			if( siteID && !this.siteIDs[username].includes(siteID) ) {
				this.siteIDs[username].push(siteID);
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
						self.doTeslaApiLogin(username,password,filename);
					}
					else {
						this.log("Missing both Tesla password and access tokens");
					}
				}
			}

			if( !this.vehicles[username]) {
				// See if there are any cars on the account.
				this.vehicles[username] = await this.doTeslaApiGetVehicleList(username);
			}

			if( !siteID ) {
				this.log("Attempting to infer siteID");
				siteID = await this.inferSiteID(username);
			}
			this.log("Found siteID " + siteID);

			this.sendSocketNotification("MMM-Powerwall-TeslaAPIConfigured", {
				username: username,
				siteID: siteID,
				vehicles: this.vehicles[username]
			});
		}
		else if (notification === "MMM-Powerwall-UpdateLocal") {
			let ip = payload.powerwallIP;
			this.initializeCache(this.powerwallAggregates, ip);
			this.initializeCache(this.powerwallSOE, ip);

			if( this.powerwallAggregates[ip].lastUpdate + payload.updateInterval < Date.now() ) {
				self.updatePowerwall(ip);
			}
			else {
				if (this.powerwallAggregates[ip].lastResult) {
					this.sendSocketNotification("MMM-Powerwall-Aggregates", {
						ip: ip,
						aggregates: this.powerwallAggregates[ip].lastResult
					});
				}
				if (this.powerwallSOE[ip].lastResult) {
					this.sendSocketNotification("MMM-Powerwall-SOE", {
						ip: ip,
						soe: this.powerwallSOE[ip].lastResult
					});
				}	
			}

			ip = payload.twcManagerIP;
			let port = payload.twcManagerPort;
			if( ip ) {
				this.initializeCache(this.twcStatus, ip);
				this.initializeCache(this.twcVINs, ip);
				if( this.twcStatus[ip].lastUpdate + (payload.updateInterval || 0) < Date.now() ) {
					self.updateTWCManager(ip, port);
				}
				else {
					this.sendSocketNotification("MMM-Powerwall-ChargeStatus", {
						ip: ip,
						status: this.twcStatus[ip].lastResult,
						vins: this.twcVINs[ip].lastResult
					});
				}
			}
		}
		else if (notification === "MMM-Powerwall-UpdateEnergy") {
			let username = payload.username;
			let siteID = payload.siteID;

			this.initializeCache(this.energy, username, siteID);

			if( this.energy[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetEnergy(username, siteID);
			}
			else {
				this.sendSocketNotification("MMM-Powerwall-EnergyData", {
					username: username,
					siteID: siteID,
					energy: this.energy[username][siteID].lastResult
				});
			}
		}
		else if (notification === "MMM-Powerwall-UpdateSelfConsumption") {
			let username = payload.username;
			let siteID = payload.siteID;

			this.initializeCache(this.selfConsumption, username, siteID);

			if( this.selfConsumption[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetSelfConsumption(username, siteID);
			}
			else {
				this.sendSocketNotification("MMM-Powerwall-SelfConsumption", {
					username: username,
					siteID: siteID,
					selfConsumption: this.selfConsumption[username][siteID].lastResult
				});
			}
		}
		else if (notification === "MMM-Powerwall-UpdateVehicleState") {
			let username = payload.username;
			let vehicleID = payload.vehicleID;

			this.initializeCache(this.driveState, username, vehicleID);
			this.initializeCache(this.chargeState, username, vehicleID);

			let useCache = !(this.driveState[username][vehicleID].lastUpdate + payload.updateInterval
				<= Date.now() );
			this.doTeslaApiGetVehicleState(username, vehicleID, useCache);
		}
	},

	initializeCache: function(node, ...rest) {
		let lastKey = rest.pop();
		for( let key of rest) {
			if( !node[key] ) {
				node[key] = {};
			}
			node = node[key];
		}
		if( !node[lastKey] ) {
			node[lastKey] = {
				lastUpdate: 0,
				lastResult: null
			};
		}
	},
	
	updateCache: function(data, node, ...keys) {
		let lastKey = keys.pop();
		for( let key of keys) {
			node = node[key];
		}
		node[lastKey] = {
			lastUpdate: Date.now(),
			lastResult: data
		};
	},

	updatePowerwall: async function(powerwallIP, powerwallPassword) {
		let url = "https://" + powerwallIP + "/api/meters/aggregates";
		let result = await fetch(url, {agent: unauthenticated_agent});
		
		if( !result.ok ) {
			this.log("Powerwall fetch failed")
			return
		}
		
		var aggregates = await result.json();
		this.updateCache(aggregates, this.powerwallAggregates, powerwallIP);
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
		this.updateCache(response.percentage, this.powerwallSOE, powerwallIP);
		this.sendSocketNotification("MMM-Powerwall-SOE", {
			ip: powerwallIP,
			soe: response.percentage
		});
	},

	updateTWCManager: async function(twcManagerIP, twcManagerPort) {
		let url = "http://" + twcManagerIP + ":" + twcManagerPort + "/api/getStatus";
		let success = true;
		try {
			var result = await fetch(url);
		}
		catch (e) {
			success = false;
		}

		if( success && result.ok ) {
			var status = await result.json();
			var vins = [];
			if( status.carsCharging > 0 ) {
				url = "http://" + twcManagerIP + ":" + port + "/api/getSlaveTWCs";

				try {
					result = await fetch(url);
				}
				catch {}

				if ( result.ok ) {
					let slaves = await result.json();
					for (let slaveID in slaves) {
						let slave = slaves[slaveID];
						if( slave.currentVIN ) {
							vins.push(slave.currentVIN);
						}
					}
				}
			}

			// Cache results
			let now = Date.now();
			this.updateCache(status, this.twcStatus, twcManagerIP);
			this.updateCache(vins, this.twcVINs, twcManagerIP);

			// Send notification
			this.sendSocketNotification("MMM-Powerwall-ChargeStatus", {
				ip: twcManagerIP,
				status: status,
				vins: vins
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

		let response = await this.doTeslaApi(url, username);
		let siteIDs = response.filter(
			product =>(product.battery_type === "ac_powerwall")
			).map(product => product.energy_site_id);

		this.log(JSON.stringify(this.siteIDs));
		if( this.siteIDs[username].length === 0 ) {	
			if (siteIDs.length === 1) {
				this.log("Inferred site ID " + siteIDs[0]);
				this.siteIDs[username].push(siteIDs[0]);
				return siteIDs[0];
			}
			else if (siteIDs.length === 0) {
				this.log("Could not find Powerwall in your Tesla account");
			}
			else {
				this.log("Found multiple Powerwalls on your Tesla account:" + siteIDs);
				this.log("Add 'siteID' to your config.js to specify which to target");
			}
		}
		else {
			if( !this.siteIDs[username].every(id => siteIDs.includes(id)) ) {
				this.log("Unknown site ID specified; found: " + siteIDs);
			}
			else {
				return this.siteIDs[username][0];
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

	doTeslaApi: async function(url, username, id_key=null,
			deviceID=null, cache_node=null, event_name=null,
			response_key=null, event_key=null) {
		let result = {};

		if( !this.teslaApiAccounts[username] ) {
			this.log("Called doTeslaApi() without credentials!")
			return {};
		}

		try {
			result = await fetch(url, {
				headers: {
					"Authorization": "Bearer " + this.teslaApiAccounts[username].access_token
				}
			});
		}
		catch (e) {
			this.log(e);
			return {};
		}

		if( result.ok ) {
			let json = await result.json();
			this.log(JSON.stringify(json));
			let response = json.response;
			if (response_key) {
				response = response[response_key];
			}

			if( event_name && id_key && event_key ) {
				let event = {
					username: username,
					[id_key]: deviceID,
					[event_key]: response
				};
				this.sendSocketNotification(event_name, event);
			}

			if( cache_node && deviceID ) {
				if( !cache_node[username] ) {
					cache_node[username] = {};
				}
				if( !cache_node[username][deviceID] ) {
					cache_node[username][deviceID] = {};
				}
				this.updateCache(response, cache_node, username, deviceID);
			}

			return response;
		}
		else {
			this.log(url + " returned " + result.status);
			this.log(await result.text());
			return {};
		}
	},

	doTeslaApiGetEnergy: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?period=day&kind=energy";
		await this.doTeslaApi(url, username, "siteID", siteID, this.energy, "MMM-Powerwall-EnergyData", "time_series", "energy");
	},

	doTeslaApiGetSelfConsumption: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?kind=self_consumption&period=day";
		await this.doTeslaApi(url, username, "siteID", siteID, this.selfConsumption, "MMM-Powerwall-SelfConsumption", "time_series", "selfConsumption");
	},

	doTeslaApiGetVehicleList: async function(username) {
		url = "https://owner-api.teslamotors.com/api/1/vehicles";
		let response = await this.doTeslaApi(url, username);
		
		// response is an array of vehicle objects.  Don't need all the properties.
		if( Array.isArray(response) ) {
			return response.map(
				function(vehicle) {
					return {
						id: vehicle.id_s,
						vin: vehicle.vin,
						display_name: vehicle.display_name
					}});
		}
		else {
			return [];
		}
	},

	doTeslaApiCommand: async function(url, username, body) {
		if( !this.teslaApiAccounts[username] ) {
			this.log("Called doTeslaApiCommand() without credentials!")
			return {};
		}

		try {
			result = await fetch(url, {
				method: "POST",
				body: JSON.stringify(body),
				headers: {
					"Authorization": "Bearer " + this.teslaApiAccounts[username].access_token
				}
			});
		}
		catch (e) {
			this.log(e);
			return {};
		}

		if( result.ok ) {
			let json = await result.json();
			this.log(JSON.stringify(json));
			let response = json.response;
			return response;
		}
		else {
			this.log(url + " returned " + result.status);
			this.log(await result.text());
			return {};
		}
	},

	delay: function wait(ms) {
		return new Promise(resolve => {
			setTimeout(resolve, ms);
		});
	},

	doTeslaApiWakeVehicle: async function(username, vehicleID) {
		let timeout = 5000;
		let url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID + "/wake_up";
		let state = "initial";

		do {
			let response = this.doTeslaApiCommand(url, username);
			state = response.state;
			if( response.state !== "online") {
				if( timeout > 600000 ) {
					break;
				}
				await this.delay(timeout);
				timeout *= 2;
			}
		} while( state != "online" );

		return state === "online";
	},

	doTeslaApiGetVehicleState: async function(username, vehicleID, useCached) {
		// Slightly more complicated; involves calling multiple APIs
		let state = "cached";
		const forceWake = !(this.driveState[username][vehicleID].lastResult && 
			this.chargeState[username][vehicleID].lastResult);
		if( !useCached || forceWake ) {
			let url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID;
			let response = await this.doTeslaApi(url, username);
			state = response.state;
			if (state !== "online" && forceWake &&
				await doTeslaApiWakeVehicle(username, vehicleID)) {
					state = "online";
			}
		}

		var drive_state, charge_state;
		if( state !== "online" ) {
			// Car is asleep and either can't wake or we aren't asking
			drive_state = this.driveState[username][vehicleID].lastResult;
			charge_state = this.chargeState[username][vehicleID].lastResult;
		}
		else {
			// Get vehicle state
			url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID + "/data_request/drive_state";
			driveState = await this.doTeslaApi(url, username, "ID", vehicleID, this.driveState);
			
			url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID + "/data_request/charge_state";
			chargeState = await this.doTeslaApi(url, username, "ID", vehicleID, this.chargeState);
		}

		this.sendSocketNotification("MMM-Powerwall-VehicleState", {
			username: username,
			ID: vehicleID,
			state: state,
			drive: {
				speed: driveState.speed,
				gear: driveState.shift_state,
				location: [driveState.latitude, driveState.longitude]
			},
			charge: {
				state: chargeState.charging_state,
				soc: chargeState.battery_level,
				limit: chargeState.charge_limit_soc,
				power: chargeState.charger_power,
				time: chargeState.time_to_full_charge
			}
		});
	}
});
