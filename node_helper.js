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
		this.powerwallCloudSOE = {};
		this.twcStatus = {};
		this.twcVINs = {};
		this.chargeHistory = {};
		this.teslaApiAccounts = {};
		this.energy = {};
		this.selfConsumption = {};
		this.siteIDs = {};
		this.vehicles = {};
		this.vehicleData = {};
		this.powerHistory = {};
		this.filenames = [];
		this.lastUpdate = 0;
		this.debug = false;
	},

	// Override socketNotificationReceived method.

	/* socketNotificationReceived(notification, payload)
	 * This method is called when a socket notification arrives.
	 *
	 * argument notification string - The identifier of the noitication.
	 * argument payload mixed - The payload of the notification.
	 */
	socketNotificationReceived: async function(notification, payload) {
		var self = this;

		this.log(notification + JSON.stringify(payload));

		if (notification === "Configure-TeslaAPI") {
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
						await self.doTeslaApiLogin(username,password,filename);
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

			this.sendSocketNotification("TeslaAPIConfigured", {
				username: username,
				siteID: siteID,
				vehicles: this.vehicles[username]
			});
		}
		else if (notification === "UpdateLocal") {
			let ip = payload.powerwallIP;
			let username = payload.username;
			let siteID = payload.siteID;
			this.initializeCache(this.powerwallAggregates, ip);
			this.initializeCache(this.powerwallSOE, ip);

			if( username && !this.checkTeslaCredentials(username) ) {
				username = null;
				siteID = null;
			}

			if( siteID ) {
				this.initializeCache(this.powerwallCloudSOE, username, siteID);
			}

			let pwPromise;
			if( this.powerwallAggregates[ip].lastUpdate + payload.updateInterval < Date.now() ) {
				pwPromise = self.updatePowerwall(ip, username, siteID, payload.resyncInterval);
			}
			else {
				pwPromise = Promise.resolve();
				let age = Date.now() - this.powerwallAggregates[ip].lastUpdate
				this.log("Returning cached local data retrieved " + age + "ms ago:" + this.powerwallAggregates[ip].lastResult);
				if (this.powerwallAggregates[ip].lastResult) {
					this.sendSocketNotification("Aggregates", {
						ip: ip,
						aggregates: this.powerwallAggregates[ip].lastResult
					});
				}
				if (this.powerwallSOE[ip].lastResult) {
					let cache = (this.powerwallCloudSOE[username] || [])[siteID] || [];
					let cloudSOE = (cache.lastResult || {}).percentage_charged || 0;
					let syncPoint = cache.syncPoint || 0;
					this.sendSocketNotification("SOE", {
						ip: ip,
						soe: cloudSOE + this.powerwallSOE[ip].lastResult - syncPoint
					});
				}
			}

			ip = payload.twcManagerIP;
			let port = payload.twcManagerPort;
			if( ip ) {
				this.initializeCache(this.twcStatus, ip);
				this.initializeCache(this.twcVINs, ip);
				if( this.twcStatus[ip].lastUpdate + (payload.updateInterval || 0) < Date.now() ) {
					await self.updateTWCManager(ip, port);
				}
				else {
					this.sendSocketNotification("ChargeStatus", {
						ip: ip,
						status: this.twcStatus[ip].lastResult,
						vins: this.twcVINs[ip].lastResult
					});
				}
			}
			await pwPromise;
		}
		else if (notification === "UpdateEnergy") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( siteID ) {
				this.initializeCache(this.energy, username, siteID);
			}
			else {
				return;
			}

			if( this.energy[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetEnergy(username, siteID);
			}
			else {
				this.sendSocketNotification("EnergyData", {
					username: username,
					siteID: siteID,
					energy: this.energy[username][siteID].lastResult
				});
			}
		}
		else if (notification === "UpdateSelfConsumption") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( siteID ) {
				this.initializeCache(this.selfConsumption, username, siteID);
			}
			else {
				return;
			}

			if( this.selfConsumption[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetSelfConsumption(username, siteID);
			}
			else {
				this.sendSocketNotification("SelfConsumption", {
					username: username,
					siteID: siteID,
					selfConsumption: this.selfConsumption[username][siteID].lastResult
				});
			}
		}
		else if (notification === "UpdatePowerHistory") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( siteID ) {
				this.initializeCache(this.powerHistory, username, siteID);
			}
			else {
				return;
			}

			if( this.powerHistory[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetPowerHistory(username, siteID);
			}
			else {
				this.sendSocketNotification("PowerHistory", {
					username: username,
					siteID: siteID,
					powerHistory: this.powerHistory[username][siteID].lastResult
				});
			}

		}
		else if (notification === "UpdateChargeHistory") {
			let twcManagerIP = payload.twcManagerIP;
			let twcManagerPort = payload.twcManagerPort;

			this.initializeCache(this.chargeHistory, twcManagerIP);

			if( this.chargeHistory[twcManagerIP].lastUpdate + payload.updateInterval < Date.now()) {
				await self.updateTWCHistory(twcManagerIP, twcManagerPort);
			}
			else {
				this.sendSocketNotification("ChargeHistory", {
					twcManagerIP: twcManagerIP,
					chargeHistory: this.chargeHistory[twcManagerIP].lastResult
				});
			}
		}
		else if (notification === "UpdateVehicleData") {
			let username = payload.username;
			let vehicleID = payload.vehicleID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( vehicleID ) {
				this.initializeCache(this.vehicleData, username, vehicleID);
			}
			else {
				return;
			}

			let useCache = !(this.vehicleData[username][vehicleID].lastUpdate + payload.updateInterval
				<= Date.now() );
			this.doTeslaApiGetVehicleData(username, vehicleID, useCache);
		}
		else if (notification === "Enable-Debug") {
			this.debug = true;
		}
	},

	checkTeslaCredentials: function(username) {
		if( this.teslaApiAccounts[username] ) {
			return true;
		}
		else {
			this.sendSocketNotification("ReconfigureTeslaAPI", {
				teslaAPIUsername: username
			});
			return false;
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

	updateCache: function(data, node, keys, time=null, target="lastResult") {
		if( !time ) {
			time = Date.now();
		}
		if( keys && !Array.isArray(keys) ) {
			keys = [keys];
		}
		let lastKey = keys.pop();
		for( let key of keys) {
			node = node[key];
		}
		node[lastKey].lastUpdate = time;
		node[lastKey][target] = data;
	},

	updatePowerwall: async function(powerwallIP, username, siteID, resyncInterval) {
		let now = Date.now();
		let url = "https://" + powerwallIP + "/api/meters/aggregates";
		this.log("Calling " + url);
		let aggregatePromise = fetch(url, {agent: unauthenticated_agent}).then(
			async result => {
				if( !result.ok ) {
					this.log("Powerwall fetch failed")
					return
				}

				var aggregates = await result.json();
				this.log("Powerwall returned: " + JSON.stringify(aggregates));
				this.updateCache(aggregates, this.powerwallAggregates, powerwallIP, now);
				// Send notification
				this.sendSocketNotification("Aggregates", {
					ip: powerwallIP,
					aggregates: aggregates
				});
			}
		);

		url = "https://" + powerwallIP + "/api/system_status/soe";
		let localPromise = fetch(url, {agent: unauthenticated_agent}).then(
			async result => {
				if( !result.ok ) {
					this.log("Powerwall SOE fetch failed");
					return null;
				}

				let response = await result.json();
				return response.percentage;
			}
		);

		url = "https://" + powerwallIP + "/api/system_status/grid_status";
		let gridPromise = fetch(url, {agent: unauthenticated_agent}).then(
			async result => {
				if( !result.ok ) {
					this.log("Powerwall Grid Status fetch failed");
					return null;
				}

				let response = await result.json();
				return response.grid_status;
			}
		)

		let cloudSOE = 0, syncPoint = 0;
		if( username && siteID ) {
			let cache = this.powerwallCloudSOE[username][siteID];
			if( cache.lastUpdate + resyncInterval < Date.now() ) {
				let url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/live_status";
				let cloudStatus = await this.doTeslaApi(url, username, null, siteID, this.powerwallCloudSOE);
				cloudSOE = cloudStatus.percentage_charged;

				this.sendSocketNotification("StormWatch", {
					ip: powerwallIP,
					storm: cloudStatus.storm_mode_active
				});

				if( cloudSOE != 0 ) {
					syncPoint = await localPromise;
					this.updateCache(syncPoint, this.powerwallCloudSOE, [username, siteID], now, "syncPoint");
				}
			}
			if( cloudSOE === 0 && cache.lastResult.percentage_charged && cache.syncPoint ) {
				cloudSOE = cache.lastResult.percentage_charged;
				syncPoint = cache.syncPoint;
			}
		}

		let localSOE = await localPromise;
		this.updateCache(localSOE, this.powerwallSOE, powerwallIP, now);

		this.sendSocketNotification("SOE", {
			ip: powerwallIP,
			soe: cloudSOE + localSOE - syncPoint
		});

		let gridStatus = await gridPromise;
		this.sendSocketNotification("GridStatus", {
			ip: powerwallIP,
			gridStatus: gridStatus
		});

		await aggregatePromise;
	},

	updateTWCManager: async function(twcManagerIP, twcManagerPort) {
		let url = "http://" + twcManagerIP + ":" + twcManagerPort + "/api/getStatus";
		let success = true;
		let now = Date.now();

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
				url = "http://" + twcManagerIP + ":" + twcManagerPort + "/api/getSlaveTWCs";

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
			this.updateCache(status, this.twcStatus, twcManagerIP, now);
			this.updateCache(vins, this.twcVINs, twcManagerIP, now);

			// Send notification
			this.sendSocketNotification("ChargeStatus", {
				ip: twcManagerIP,
				status: status,
				vins: vins
			});
		}
		else {
			this.log("TWCManager fetch failed")
		}
	},

	updateTWCHistory: async function(twcManagerIP, twcManagerPort) {
		let url = "http://" + twcManagerIP + ":" + twcManagerPort + "/api/getHistory";
		let success = true;
		let now = Date.now();

		try {
			var result = await fetch(url);
		}
		catch (e) {
			success = false;
		}

		if( success && result.ok ) {
			var history = await result.json();
			this.updateCache(history, this.chargeHistory, twcManagerIP, now);
			this.sendSocketNotification("ChargeHistory", {
				twcManagerIP: twcManagerIP,
				chargeHistory: history
			});
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

		this.log("Fetching products list");
		let response = await this.doTeslaApi(url, username);
		if( !Array.isArray(response) ) {
			return null;
		}

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
				console.log("Could not find Powerwall in your Tesla account");
			}
			else {
				console.log("Found multiple Powerwalls on your Tesla account:" + siteIDs);
				console.log("Add 'siteID' to your config.js to specify which to target");
			}
		}
		else {
			if( !this.siteIDs[username].every(id => siteIDs.includes(id)) ) {
				console.log("Unknown site ID specified; found: " + siteIDs);
			}
			else {
				return this.siteIDs[username][0];
			}
		}
		return null;
	},

	log: function(message) {
		if( this.debug ) {
			console.log("MMM-Powerwall: " + message);
		}
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
		let now = Date.now();

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
			this.log(url + " returned " + JSON.stringify(json));
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

			if( response && cache_node && deviceID ) {
				if( !cache_node[username] ) {
					cache_node[username] = {};
				}
				if( !cache_node[username][deviceID] ) {
					cache_node[username][deviceID] = {};
				}
				this.updateCache(response, cache_node, [username, deviceID], now);
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
		await this.doTeslaApi(url, username, "siteID", siteID, this.energy, "EnergyData", "time_series", "energy");
	},

	doTeslaApiGetPowerHistory: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?period=day&kind=power";
		await this.doTeslaApi(url, username, "siteID", siteID, this.powerHistory, "PowerHistory", "time_series", "powerHistory");
	},

	doTeslaApiGetSelfConsumption: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?kind=self_consumption&period=day";
		await this.doTeslaApi(url, username, "siteID", siteID, this.selfConsumption, "SelfConsumption", "time_series", "selfConsumption");
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
			let response = await this.doTeslaApiCommand(url, username);
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

	doTeslaApiGetVehicleData: async function(username, vehicleID, useCached) {
		// Slightly more complicated; involves calling multiple APIs
		let state = "cached";
		const forceWake = !(this.vehicleData[username][vehicleID].lastResult);
		if( !useCached || forceWake ) {
			let url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID;
			let response = await this.doTeslaApi(url, username);
			state = response.state;
			if (state !== "online" && forceWake &&
				await this.doTeslaApiWakeVehicle(username, vehicleID)) {
					state = "online";
			}
		}

		var data;
		if( state !== "online" ) {
			// Car is asleep and either can't wake or we aren't asking
			data = this.vehicleData[username][vehicleID].lastResult;
		}
		else {
			// Get vehicle state
			url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID + "/vehicle_data";
			data = await this.doTeslaApi(url, username, "ID", vehicleID, this.vehicleData);
		}

		if( data &&
			["vehicle_state", "drive_state", "gui_settings", "charge_state", "vehicle_config"].every(
				key => key in data
			) )
		{
			let power = data.charge_state.charger_actual_current * data.charge_state.charger_voltage;
			this.sendSocketNotification("VehicleData", {
				username: username,
				ID: vehicleID,
				state: state,
				sentry: data.vehicle_state.sentry_mode,
				drive: {
					speed: data.drive_state.speed,
					units: data.gui_settings.gui_distance_units,
					gear: data.drive_state.shift_state,
					location: [data.drive_state.latitude, data.drive_state.longitude]
				},
				charge: {
					state: data.charge_state.charging_state,
					soc: data.charge_state.battery_level,
					limit: data.charge_state.charge_limit_soc,
					power: power,
					time: data.charge_state.time_to_full_charge
				},
				config: {
					car_type: data.vehicle_config.car_type,
					option_codes: data.option_codes,
					exterior_color: data.vehicle_config.exterior_color,
					wheel_type: data.vehicle_config.wheel_type
				}
			});
		}
	}
});
