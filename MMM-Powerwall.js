/* Magic Mirror
 * Module: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

const SOLAR = { key: "solar", displayAs: "Solar", color: "gold", color_trans: "rgba(255, 215, 0, 0.7)" };
const POWERWALL = { key: "battery", displayAs: "Powerwall", color: "#0BC60B", color_trans: "rgba(11, 198, 11, 0.7)"};
const GRID = { key: "grid", displayAs: "Grid", color: "#CACECF", color_trans: "rgba(202, 206, 207, 0.7)" };
const HOUSE = { key: "house", displayAs: "Local Usage", color: "#09A9E6", color_trans: "rgba(9, 169, 230, 0.7)" };
const CAR = { key: "car", displayAs: "Car Charging", color: "#B91413", color_trans: "rgba(185, 20, 19, 0.7)" };

const REQUIRED_CALLS = {
	CarCharging: ["local", "vehicle"],
	PowerwallSelfPowered: ["local", "selfConsumption"],
	SolarProduction: ["local", "energy"],
	HouseConsumption: ["local", "energy"],
	EnergyBar: ["local", "energy"],
	PowerLine: ["power"]
}

const DISPLAY_SOURCES = [
	POWERWALL,
	SOLAR,
	GRID
];
const DISPLAY_SINKS = [
	POWERWALL,
	CAR,
	HOUSE,
	GRID
];
var DISPLAY_ALL = [
	GRID,
	POWERWALL,
	HOUSE,
	CAR,
	SOLAR
];

Module.register("MMM-Powerwall", {
	defaults: {
		graphs: [
			"CarCharging",
			"PowerwallSelfPowered",
			"SolarProduction",
			"HouseConsumption",
			"EnergyBar",
			"PowerLine"
		],
		localUpdateInterval: 10000,
		cloudUpdateInterval: 300000,
		powerwallIP: null,
		siteID: null,
		twcManagerIP: null,
		twcManagerPort: 8080,
		teslaAPIUsername: null,
		teslaAPIPassword: null,
		home: null,
		debug: false
	},
	requiresVersion: "2.1.0", // Required version of MagicMirror
	twcEnabled: null,
	teslaAPIEnabled: false,
	teslaAggregates: null,
	flows: null,
	historySeries: null,
	callsToEnable: {},
	numCharging: 0,
	yesterdaySolar: null,
	yesterdayUsage: null,
	gridStatus: "SystemGridConnected",
	stormWatch: false,
	dayStart: null,
	dayMode: "day",
	energyData: null,
	charts: {},
	powerHistoryChanged: false,
	selfConsumptionToday: [0, 0, 100],
	selfConsumptionYesterday: null,
	suspended: false,
	soe: 0,
	vehicles: null,
	displayVehicles: [],
	vehicleInFocus: null,
	cloudInterval: null,
	timeouts: {},

	Log: function(string) {
		if( this.config.debug ) {
			Log.log(string);
		}
	},

	start: async function() {
		var self = this;

		//Flag for check if module is loaded
		this.loaded = false;

		if (self.config.twcManagerIP) {
			self.twcEnabled = true;
		}
		else {
			self.twcEnabled = false;
			DISPLAY_ALL.splice(3, 1);
		}

		if( this.config.debug ) {
			this.sendSocketNotification("Enable-Debug");
		}

		let callsToEnable = new Set();
		this.config.graphs.forEach(
			graph => REQUIRED_CALLS[graph].forEach(
				call => callsToEnable.add(call)
			)
		);
		callsToEnable.forEach(call => {
			self.callsToEnable[call] = true;
		});

		//Send settings to helper
		if (self.config.teslaAPIUsername ) {
			this.configureTeslaApi();
			this.Log("Enabled Tesla API");
		}

		setInterval(function() {
			self.checkTimeouts();
			self.advanceToNextVehicle();
		}, 20000);
		this.updateLocal();
		await this.advanceDayMode();
	},

	updateLocal: function() {
		if( this.callsToEnable.local ) {
			this.Log("Requesting local data");
			let self = this;
			let config = this.config;
			this.sendSocketNotification("UpdateLocal", {
				powerwallIP: config.powerwallIP,
				twcManagerIP: config.twcManagerIP,
				twcManagerPort: config.twcManagerPort,
				updateInterval: config.localUpdateInterval - 500,
				username: config.teslaAPIUsername,
				siteID: config.siteID,
				resyncInterval: config.cloudUpdateInterval - 500
			});
			this.doTimeout("local", () => self.updateLocal(), this.config.localUpdateInterval);
		}
	},

	configureTeslaApi: function() {
		if (this.config.teslaAPIUsername ) {
			this.Log("Configuring Tesla API");
			this.sendSocketNotification("Configure-TeslaAPI",
			{
				siteID: this.config.siteID,
				teslaAPIUsername: this.config.teslaAPIUsername,
				teslaAPIPassword: this.config.teslaAPIPassword,
				tokenFile: this.file("tokens.json")
			});
			this.Log("Enabled Tesla API");
		}
	},

	getTemplate: function() {
		return "MMM-Powerwall.njk";
	},

	getTemplateData: function() {
		let result = {
			id: this.identifier,
			dayMode: this.dayMode,
			config: this.config,
			twcEnabled: this.twcEnabled,
			teslaAPIEnabled: this.teslaAPIEnabled,
			flows: this.flows,
			charge: true,
			totals: this.totals,
			sunrise: this.sunrise,
			soe: this.soe,
			historySeries: this.historySeries,
			numCharging: this.numCharging,
		};

		this.Log("Returning " + JSON.stringify(result));
		return result;
	},

	getScripts: function() {
		return [
			this.file("node_modules/chart.js/dist/Chart.bundle.js"),
			this.file("node_modules/chartjs-plugin-datalabels/dist/chartjs-plugin-datalabels.min.js"),
			"https://cdn.jsdelivr.net/gh/mill1000/chartjs-plugin-annotation@v0.5.8/chartjs-plugin-annotation.min.js",
		];
	},

	getStyles: function () {
		return [
			"MMM-Powerwall.css",
		];
	},

	updateEnergy: function() {
		// Energy gets updated with the local timeout, because it's not
		// requested on a recurring basis.  Recency affects the accuracy.
		if( this.callsToEnable.energy &&
			this.teslaAPIEnabled && this.config.siteID ) {
				this.Log("Requesting energy data");
				this.sendDataRequestNotification("UpdateEnergy");
		}
	},

	sendDataRequestNotification: function(notification) {
		if( this.teslaAPIEnabled ) {
			this.sendSocketNotification(notification, {
				username: this.config.teslaAPIUsername,
				siteID: this.config.siteID,
				updateInterval: this.config.cloudUpdateInterval - 500
			});
		}
	},

	updatePowerHistory: function() {
		if( this.callsToEnable.power ) {
			this.sendDataRequestNotification("UpdatePowerHistory");
			if( this.twcEnabled ) {
				this.Log("Requesting power history data");
				this.sendSocketNotification("UpdateChargeHistory", {
					twcManagerIP: this.config.twcManagerIP,
					twcManagerPort: this.config.twcManagerPort,
					updateInterval: this.config.localUpdateInterval - 500
				});
			}
		}
	},

	updateSelfConsumption: function() {
		if( this.callsToEnable.selfConsumption ) {
			this.Log("Requesting self-consumption data");
			this.sendDataRequestNotification("UpdateSelfConsumption");
		}
	},

	updateVehicleData: function(timeout=null) {
		if( this.callsToEnable.vehicle ) {
			let now = Date.now();
			let willingToDefer = false;
			if( !timeout ) {
				timeout = this.config.cloudUpdateInterval;
				willingToDefer = true;
			}
			if( Array.isArray(this.vehicles) ) {
				for( let vehicle of this.vehicles) {
					if( willingToDefer && vehicle.deferUntil && now < vehicle.deferUntil) {
						continue;
					}

					this.Log("Requesting vehicle data");
					this.sendSocketNotification("UpdateVehicleData", {
						username: this.config.teslaAPIUsername,
						vehicleID: vehicle.id,
						updateInterval: timeout - 500
					});
				}
			}
		}
	},

	// socketNotificationReceived from helper
	socketNotificationReceived: async function (notification, payload) {
		var self = this;
		this.Log("Received " + notification + ": " + JSON.stringify(payload));
		switch(notification) {
			case "ReconfigureTeslaAPI":
				if( payload.teslaAPIUsername == self.config.teslaAPIUsername ) {
					this.configureTeslaApi();
				}
				break;
			case "TeslaAPIConfigured":
				if( payload.username === self.config.teslaAPIUsername ) {
					this.teslaAPIEnabled = true;
					if( !self.config.siteID ) {
						self.config.siteID = payload.siteID;
					}
					if( self.config.siteID === payload.siteID ) {
						self.teslaAPIEnabled = true;
						this.updateEnergy();
						this.updateSelfConsumption();
						this.updatePowerHistory();
						this.doTimeout("cloud", () => {
							self.updateSelfConsumption();
							self.updatePowerHistory();
						}, this.config.cloudUpdateInterval);
					}
					this.updateLocal();
					this.vehicles = payload.vehicles;
					this.updateVehicleData();
					await this.focusOnVehicles(this.vehicles, 0);
				}
				break;

			case "Aggregates":
				if( payload.ip === this.config.powerwallIP ) {
					this.doTimeout("local", () => self.updateLocal(), self.config.localUpdateInterval)

					let needUpdate = false;
					if (!this.flows) {
						needUpdate = true;
					}

					this.teslaAggregates = payload.aggregates;
					this.flows = this.attributeFlows(payload.aggregates, self.twcConsumption);

					if( this.energyData) {
						this.generateDaystart(this.energyData);
						this.energyData = null;
					}

					if (needUpdate) {
						// If we didn't have data before, we need to redraw
						this.buildGraphs();
					}

					// We're updating the data in-place.
					await this.updateData();
				}
				break;
			case "SOE":
				if( payload.ip === this.config.powerwallIP ) {
					this.soe = payload.soe;
					this.updateNode(
						this.identifier + "-PowerwallSOE",
						payload.soe,
						"%",
						"",
						false);
					let meterNode = document.getElementById(this.identifier + "-battery-meter");
					if (meterNode) {
						meterNode.style = "height: " + payload.soe + "%;";
					}
				}
				break;
			case "ChargeStatus":
				if( payload.ip === this.config.twcManagerIP ) {
					let oldConsumption = self.twcConsumption;
					self.twcConsumption = Math.round( parseFloat(payload.status.chargerLoadWatts) );
					if( self.twcConsumption !== oldConsumption && this.teslaAggregates ) {
						this.flows = this.attributeFlows(this.teslaAggregates, self.twcConsumption);
						await this.updateData();
					}

					if( payload.status.carsCharging > 0 && this.vehicles ) {
						// Charging at least one car
						let charging = this.flows.sinks.car.total;
						this.updateNode(this.identifier + "-CarConsumption", charging, "W");

						let vinsWeKnow = (payload.vins || []).filter(
							chargingVIN => this.vehicles.some(
								knownVehicle => knownVehicle.vin == chargingVIN
							)
						) || [];
						let vehicles;

						if (vinsWeKnow.length > 0) {
							// We recognize some charging VINs!
							vehicles = vinsWeKnow.map(vin => this.vehicles.find(
								vehicle => vehicle.vin == vin
							));
							vehicles.sort( (a,b) => (
								a.charge && b.charge &&
									a.charge.soc && b.charge.soc ?
								(a.charge.soc - b.charge.soc) :
								a.charge ? -1 : 1));
						}
						else {
							// Charging cars are unknown; TWCs can't report VINs?
							// Show any cars the API indicates are currently
							// charging. This will have some false positives if
							// charging off-site, and will be slow to detect
							// vehicles.
							vehicles = this.vehicles.filter(
								knownVehicle =>
									knownVehicle.charge &&
									knownVehicle.charge.state === "Charging"
							);
						}

						if (vehicles.map(
								vehicle => vehicle.charge ?
									(vehicle.charge.power != 0 ?
										this.flows.sinks.car.total / (vehicle.charge.power * payload.status.carsCharging) :
										2) :
									1
							).some(ratio => ratio > 1.25 || ratio < 0.75 )) {
								this.updateVehicleData(30000);
						}
						await this.focusOnVehicles(vehicles, payload.status.carsCharging)
					}
					else {
						// No cars are charging.
						await this.focusOnVehicles(this.vehicles, 0);
					}
				}
				break;

			case "EnergyData":
				if( payload.username === this.config.teslaAPIUsername &&
					this.config.siteID == payload.siteID ) {

					if( this.teslaAggregates ) {
						this.generateDaystart(payload);
					}
					else {
						this.energyData = payload
					}
					this.updateData();
				}
				break;
			case "PowerHistory":
				if( payload.username === this.config.teslaAPIUsername &&
					this.config.siteID == payload.siteID ) {
						this.powerHistory = payload.powerHistory;
						this.updatePowerLine();
				}
				break;
			case "ChargeHistory":
				if( payload.twcManagerIP === this.config.twcManagerIP ) {
					this.chargeHistory = payload.chargeHistory;
					this.cachedCarTotal = null;
					this.updatePowerLine();
				}
				break;
			case "SelfConsumption":
				if( payload.username === this.config.teslaAPIUsername &&
					this.config.siteID == payload.siteID ) {
						this.doTimeout("cloud", () => {
							self.updateSelfConsumption();
							self.updatePowerHistory();
						}, this.config.cloudUpdateInterval);

						let yesterday = payload.selfConsumption[0];
						let today = payload.selfConsumption[1];
						this.selfConsumptionYesterday = [
							yesterday.solar,
							yesterday.battery,
							100 - yesterday.solar - yesterday.battery
						];
						this.selfConsumptionToday = [
							today.solar,
							today.battery,
							100 - today.solar - today.battery
						];
						this.updateNode(
							this.identifier + "-SelfPoweredTotal",
							Math.round(this.selfConsumptionToday[0]) + Math.round(this.selfConsumptionToday[1]),
							"%"
						);
						this.updateNode(
							this.identifier + "-SelfPoweredYesterday",
							Math.round(this.selfConsumptionYesterday[0]) + Math.round(this.selfConsumptionYesterday[1]),
							"% Yesterday"
						);
						let scChart = this.charts.selfConsumption
						if( scChart ) {
							scChart.data.datasets[0].data = this.selfConsumptionToday;
							scChart.update();
						}
				}
				break;
			case "VehicleData":
				// username: username,
				// ID: vehicleID,
				// state: state,
				// sentry: data.vehicle_state.sentry_mode,
				// drive: {
				// 	speed: data.drive_state.speed,
				// 	units: data.gui_settings.gui_distance_units,
				// 	gear: data.drive_state.shift_state,
				// 	location: [data.drive_state.latitude, data.drive_state.longitude]
				// },
				// charge: {
				// 	state: data.charge_state.charging_state,
				// 	soc: data.charge_state.battery_level,
				// 	limit: data.charge_state.charge_limit_soc,
				// 	power: data.charge_state.charger_power,
				// 	time: data.charge_state.time_to_full_charge
				// }

				if( payload.username === this.config.teslaAPIUsername ) {
					let intervalToUpdate = this.config.cloudUpdateInterval;
					let exempt = true;
					if( payload.state === "online" && payload.drive.gear === "D" ) {
						intervalToUpdate = 2*this.config.localUpdateInterval + this.config.cloudUpdateInterval;
						intervalToUpdate /= 3;
						exempt = false;
					}
					this.doTimeout("vehicle", () => self.updateVehicleData(), intervalToUpdate, exempt);

					let statusFor = (this.vehicles || []).find(vehicle => vehicle.id == payload.ID);
					if( !statusFor ) {
						break;
					}

					if( payload.state === "online" && !payload.drive.gear && !payload.sentry && payload.charge.power == 0 ) {
						// If car is idle and not in Sentry mode, don't request data for half an hour;
						// let it try to sleep.
						statusFor.deferUntil = Date.now() + 30*60*1000;
					}
					else {
						delete statusFor.deferUntil;
					}

					if( !statusFor.imageUrl ) {
						statusFor.imageUrl = this.createCompositorUrl(payload.config);
					}
					statusFor.drive = payload.drive;
					statusFor.charge = payload.charge;
					if( !this.vehicleInFocus ) {
						this.advanceToNextVehicle();
					}
					else if( statusFor === this.vehicleInFocus ) {
						await this.drawStatusForVehicle(statusFor, this.numCharging, false);
					}
				}
				break;
			case "GridStatus":
				if( payload.ip === this.config.powerwallIP ) {
					this.gridStatus = payload.gridStatus;
				}
				this.updateGrid();
				break;
			case "StormWatch":
				if( payload.ip === this.config.powerwallIP ) {
					this.stormWatch = payload.storm;
				}
				this.updateGrid();
				break;
			default:
				break;
		}
	},

	updateGrid: function() {
		let borderTarget = document.getElementById(this.identifier + "-PowerwallSelfPowered");
		let statusTarget = document.getElementById(this.identifier + "-StatusOverlay");
		let displayText = {
			"storm-watch": "Storm Watch",
			"grid-outage": "Grid Outage",
			"grid-sync": "Grid Sync",
			border: null
		};
		let result;

		switch(this.gridStatus) {
			default:
			case "SystemGridConnected":
				// Grid is fine; check for Storm Watch
				if( this.stormWatch ) {
					result = "storm-watch";
				}
				else {
					result = null;
				}
				break;
			case "SystemIslandedActive":
				// Grid is down
				result = "grid-outage";
				break;
			case "SystemTransitionToGrid":
				// Grid is coming up
				result = "grid-sync";
				break;
		}

		if( borderTarget ) {
			borderTarget.classList.remove(...Object.keys(displayText));
			if( result ) {
				borderTarget.classList.add(result);
				borderTarget.classList.add("border");
			}
		}
		if( statusTarget ) {
			statusTarget.classList.remove(...Object.keys(displayText));
			statusTarget.textContent = displayText[result];
			if( result ) {
				statusTarget.classList.add(result);
			}
		}
	},

	doTimeout: function(name, func, timeout, exempt=false) {
		if( this.timeouts[name] ) {
			clearTimeout(this.timeouts[name].handle);
		}
		let delay = timeout + (Math.random() * 3000) - 500;
		if( delay < 500 ) {
			delay = 500;
		}
		this.timeouts[name] = {
			func: func,
			target: Date.now() + delay,
			exempt: exempt
		};
		if( !this.suspended || !exempt ) {
			this.timeouts[name].handle = setTimeout(() => func(), delay);
		}
	},

	checkTimeouts: function() {
		for( let name in this.timeouts ) {
			if( (!this.suspended || this.timeouts.exempt) && Date.now() - this.timeouts[name].target > 5000 ) {
				this.timeouts[name].func();
				this.timeouts[name].target = Date.now();
			}
		}
	},

	suspend: function() {
		this.suspended = true;
		for( let name in this.timeouts ) {
			clearTimeout(this.timeouts[name].handle)
		}
	},

	resume: function() {
		this.suspended = false;
		this.checkTimeouts();
	},

	generateDaystart: function(payload) {
		this.yesterdaySolar = payload.energy[0].solar_energy_exported;
		this.yesterdayUsage = (
			payload.energy[0].consumer_energy_imported_from_grid +
			payload.energy[0].consumer_energy_imported_from_solar +
			payload.energy[0].consumer_energy_imported_from_battery
		);

		let todaySolar = payload.energy[1].solar_energy_exported;

		let todayGridIn = payload.energy[1].grid_energy_imported;
		let todayGridOut = (
			payload.energy[1].grid_energy_exported_from_solar +
			payload.energy[1].grid_energy_exported_from_battery +
			payload.energy[1].grid_energy_exported_from_generator
		);

		let todayBatteryIn = payload.energy[1].battery_energy_exported;
		let todayBatteryOut = (
			payload.energy[1].battery_energy_imported_from_grid +
			payload.energy[1].battery_energy_imported_from_solar +
			payload.energy[1].battery_energy_imported_from_generator
		);

		let todayUsage = (
			payload.energy[1].consumer_energy_imported_from_grid +
			payload.energy[1].consumer_energy_imported_from_solar +
			payload.energy[1].consumer_energy_imported_from_battery
		);

		this.dayStart = {
			solar: {
				export: (
					this.teslaAggregates.solar.energy_exported -
					todaySolar
				)
			},
			grid: {
				export: (
					this.teslaAggregates.site.energy_exported -
					todayGridOut
				),
				import: (
					this.teslaAggregates.site.energy_imported -
					todayGridIn
				)
			},
			house: {
				import: (
					this.teslaAggregates.load.energy_imported -
					todayUsage
				)
			},
			battery: {
				export: (
					this.teslaAggregates.battery.energy_exported -
					todayBatteryIn
				),
				import: (
					this.teslaAggregates.battery.energy_imported -
					todayBatteryOut
				)
			}
		};
	},

	updatePowerLine: function() {
		let powerLine = this.charts.powerLine;
		if( powerLine ) {
			let lastMidnight = new Date().setHours(0,0,0,0);
			let newData = this.processPowerHistory();

			if( powerLine.options.scales.xAxes[0].ticks.min == lastMidnight
				&& powerLine.data && powerLine.data.datasets.length == newData.datasets.length ) {
					powerLine.data.labels = newData.labels;
					for( let i = 0; i < newData.datasets.length; i++ ) {
						powerLine.data.datasets[i].data = newData.datasets[i].data;
					}
			}
			else {
				powerLine.options.scales.xAxes[0].ticks.min = lastMidnight;
				powerLine.options.scales.xAxes[0].ticks.max = new Date().setHours(24,0,0,0);
				powerLine.data = newData;
			}

			powerLine.update();
		}
	},

	drawStatusForVehicle: async function(statusFor, numCharging, hidden) {
		if( !statusFor || !statusFor.drive ) {
			return false;
		}

		let statusText = statusFor.display_name;
		let animate = !hidden;
		let number = 0;
		let unit = "W";
		let consumptionVisible;
		let addLocation = false;
		let postLocation = "";
		let consumptionId = this.identifier + "-CarConsumption";
		let completionParaId = this.identifier + "-CarCompletionPara";

		let picture = document.getElementById(this.identifier + "-Picture");
		if( picture && statusFor.imageUrl && picture.src !== statusFor.imageUrl ) {
			picture.src = statusFor.imageUrl;
		}

		if( numCharging > 0) {
			// Cars are charging, including this one
			if( numCharging > 1) {
				statusText += " and " + (numCharging - 1) + " more are";
			}
			else {
				statusText += " is";
			}
			statusText += " charging at";

			if( statusFor.charge.time > 0 ) {
				let timeText = "";
				let hours = Math.trunc(statusFor.charge.time);
				let minutes = Math.round(
					(statusFor.charge.time - hours)
					* 12) * 5;
				if( statusFor.charge.time >= 1 ) {
					timeText = hours >= 2 ? (hours + " hours ") : "1 hour ";
				}
				if( minutes > 0 ) {
					timeText += minutes + " minutes";
				}
				this.updateText(this.identifier + "-CarCompletion", timeText, animate);
				this.makeNodeVisible(completionParaId);
			}
			else {
				this.makeNodeInvisible(completionParaId)
			}
			consumptionVisible = true;

		}
		else {
			// Cars not charging; show current instead
			statusText += " is";
			switch (statusFor.drive.gear) {
				case "D":
				case "R":
					statusText += " driving";
					addLocation = true;

					unit = statusFor.drive.units;
					if( unit === "mi/hr" ) {
						number = statusFor.drive.speed;
					}
					else {
						// Convert to kph, since API reports mph
						number = statusFor.drive.speed * 1.609344;
					}

					this.updateNode(consumptionId, number, unit, "", animate);

					consumptionVisible = true;

					break;

				default:
					switch( statusFor.charge.state ) {
						case "Disconnected":
							statusText += " parked";
							break;
						case "Charging":
							// Car charging away from home, or no TWCManager
							statusText += " charging";
							break;
						default:
							postLocation = " and not charging";
							break;
					}

					number = null;
					unit = "";

					if( this.isHome(statusFor.drive.location) ) {
						statusText += " at home";
						addLocation = false;
					}
					else {
						addLocation = true;
					}

					consumptionVisible = false;
					break;
			}

			if( addLocation ) {
				if (statusFor.namedLocation && statusFor.locationText &&
					this.isSameLocation(statusFor.namedLocation, statusFor.drive.location)) {
					statusText += " in " + statusFor.locationText;
				}
				else {
					let url =
						"https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?" +
						"f=json&preferredLabelValues=localCity&featureTypes=Locality&location=" +
						statusFor.drive.location[1] + "%2C" + statusFor.drive.location[0];
					try {
						let result = await fetch(url);
						if( result.ok ) {
							let revGeo = await result.json();
							if( revGeo.address.Match_addr ) {
								statusText += " in " + revGeo.address.Match_addr;
								statusFor.locationText = revGeo.address.Match_addr;
								statusFor.namedLocation = statusFor.drive.location;
							}
						}
					}
					catch {
						statusFor.locationText = null;
					}
				}
			}
			statusText += postLocation;
			this.makeNodeInvisible(completionParaId);
		}

		this.updateText(this.identifier + "-CarStatus", statusText, animate);
		let meterNode = document.getElementById(this.identifier + "-car-meter");
		if( meterNode ) {
			meterNode.style.width = statusFor.charge.soc + "%";
		}
		this.updateNode(
			this.identifier + "-car-meter-text",
			statusFor.charge.soc,
			"%",
			"",
			animate
		);
		if( consumptionVisible ) {
			this.makeNodeVisible(consumptionId);
		}
		else {
			this.makeNodeInvisible(consumptionId);
		}
		return true;
	},

	isHome: function(location) {
		return this.isSameLocation(this.config.home, location);
	},

	isSameLocation: function(l1, l2) {
		if( Array.isArray(l1) && Array.isArray(l2) ) {
			return Math.abs(l1[0] - l2[0]) < 0.0289 &&
				Math.abs(l1[1] - l2[1]) < 0.0289;
		}
		return null;
	},

	formatAsK: function(number, unit) {
		let separator = (unit[0] === "%") ? "" : " "
		if( number > 950 ) {
			return Math.round(number / 100) / 10.0 + separator + "k" + unit;
		}
		else {
			return Math.round(number) + separator + unit;
		}
	},

	updateNode: function(id, value, unit, prefix="", animate=true) {
		this.updateText(id, prefix + this.formatAsK(value, unit), animate);
	},

	updateText: function(id, text, animate = true) {
		let targetNode = document.getElementById(id);
		if (targetNode && targetNode.innerText !== text ) {
			if( animate ) {
				targetNode.style.opacity = 0
				setTimeout(function (){
					targetNode.innerText = text;
					targetNode.style.opacity = 1;
				}, 250)
			}
			else {
				targetNode.innerText = text;
			}
		}
	},

	updateChart: function(chart, display_array, distribution) {
		if( chart ) {
			chart.data.datasets[0].data = display_array.map( (entry) => distribution[entry.key] );
			chart.update();
		}
	},

	makeNodeVisible: function(identifier) {
		this.setNodeVisibility(identifier, "block");
	},
	
	setNodeVisibility: function(identifier, value) {
		let node = document.getElementById(identifier);
		if( node ) {
			node.style.display = value;
		}
	},

	makeNodeInvisible: function(identifier) {
		this.setNodeVisibility(identifier, "none");
	},

	updateData: async function() {
		// Check if we need to advance dayMode
		let now = new Date();
		if( this.dayNumber != now.getDay() ||
			!this.sunrise || !this.sunset ||
			(this.dayMode === "morning" && now.getTime() > this.sunrise) ||
			(this.dayMode === "day" && now.getTime() > this.sunset) ) {
				await this.advanceDayMode();
		}

		// Check for any overdue timeouts
		this.checkTimeouts();
		let anyProductionToday = this.teslaAggregates && this.dayStart &&
			this.teslaAggregates.solar.energy_exported > this.dayStart.solar.export;
		let isDay = this.dayMode === "day" && anyProductionToday;
		let showCurrent = isDay && this.flows && this.flows.sources.solar.total > 5;

		/*******************
		 * SolarProduction *
		 *******************/
		if( this.flows ) {
			this.updateNode(
				this.identifier + "-SolarProduction",
				this.flows.sources.solar.total,
				"W",
				"",
				this.dayMode === "day"
			);
			this.updateChart(this.charts.solarProduction, DISPLAY_SINKS, this.flows.sources.solar.distribution);
			let dayContent = this.identifier + "-SolarDay";
			let nightContent = this.identifier + "-SolarNight";
			if( showCurrent ) {
				this.makeNodeVisible(dayContent);
				this.makeNodeInvisible(nightContent);
			}
			else {
				this.makeNodeInvisible(dayContent);
				this.makeNodeVisible(nightContent);
				this.updateText(
					this.identifier + "-SolarHeader",
					isDay ? "Solar has produced" : "Solar produced"
				)
				this.updateText(
					this.identifier + "-SolarTodayYesterday",
					(this.dayMode === "morning" || !anyProductionToday) ? "yesterday" :
						(( isDay === "day" ? "so far " : "" ) + "today")
				);
			}
		}

		if( this.teslaAggregates && this.dayStart ) {
			this.updateNode(
				this.identifier + "-SolarTotalTextA",
				this.teslaAggregates.solar.energy_exported - this.dayStart.solar.export,
				"Wh today", "", showCurrent
			);
			this.updateNode(
				this.identifier + "-SolarYesterdayTotal",
				this.yesterdaySolar,
				"Wh yesterday", "", showCurrent
			);
			this.updateNode(
				this.identifier + "-SolarTotalB",
				(this.dayMode === "morning" || !anyProductionToday) ?
					this.yesterdaySolar :
					(this.teslaAggregates.solar.energy_exported - this.dayStart.solar.export),
				"Wh", "", !showCurrent
			);
			this.makeNodeVisible(this.identifier + "-SolarTotalTextA");
			this.makeNodeVisible(this.identifier + "-SolarYesterdayTotal");
		}


		/********************
		 * HouseConsumption *
		 ********************/
		if( this.flows ) {
			this.updateNode(this.identifier + "-HouseConsumption", this.flows.sinks.house.total, "W");
			this.updateChart(this.charts.houseConsumption, DISPLAY_SOURCES, this.flows.sinks.house.sources);
			if( this.dayStart ) {
				this.updateNode(
					this.identifier + "-UsageTotal",
					this.teslaAggregates.load.energy_imported - this.dayStart.house.import - this.carTotalToday(),
					"Wh today"
				);
				this.updateNode(
					this.identifier + "-UsageTotalYesterday",
					this.yesterdayUsage - this.carTotalYesterday(),
					"Wh yesterday"
				)
				this.makeNodeVisible(this.identifier + "-UsageTotal");
				this.makeNodeVisible(this.identifier + "-UsageTotalYesterday");
			}
		}

		/*******************
		 * Powerwall Meter *
		 *******************/
		if( this.teslaAggregates ) {
			let battery = this.teslaAggregates.battery.instant_power;
			let targetId = this.identifier + "-PowerwallStatus";
			if( Math.abs(battery) > 20 ) {
				this.updateNode(
					targetId,
					Math.abs(battery),
					"W",
					battery > 0 ? "Supplying " : "Charging at ",
					false
				);
			}
			else {
				this.updateText(targetId, "Standby");
			}
		}

		/****************
		 * Energy Flows *
		 ****************/
		let energyBar = this.charts.energyBar;
		if( energyBar ) {
			energyBar.data.datasets[0].data = this.dataTotals();
			energyBar.update();
		}
	},

	dataTotals: function() {
		let carTotal = this.carTotalToday();
		if( this.dayStart ) {
			let result = [
				// Grid out/in
				[
					this.dayStart.grid.export -
						this.teslaAggregates.site.energy_exported,
					this.teslaAggregates.site.energy_imported - this.dayStart.grid.import
				],
				// Battery out/in
				[
					this.dayStart.battery.import - this.teslaAggregates.battery.energy_imported,
					this.teslaAggregates.battery.energy_exported -
						this.dayStart.battery.export
				],
				// House out
				[
					carTotal + this.dayStart.house.import - this.teslaAggregates.load.energy_imported,
					0
				],
				// Car out - TODO
				[
					-1 * carTotal,
					0
				],
				// Solar in
				[
					0,
					this.teslaAggregates.solar.energy_exported -
					this.dayStart.solar.export
				]
			];
			if( !this.twcEnabled ) {
				result.splice(3,1);
			}
			return result;
		}
		else {
			return Array(5).fill(Array(2).fill(0));
		}
	},

	cachedCarTotal: null,
	carTotalToday: function() {
		if( Array.isArray(this.chargeHistory) && !this.cachedCarTotal ) {
			let midnight = new Date().setHours(0,0,0,0);
			this.cachedCarTotal = this.chargeHistory.filter(
				entry => Date.parse(entry.timestamp) >= midnight
			).reduce((total, next) => total + next.charger_power / 12, 0)
		}
		return this.cachedCarTotal || 0;
	},
	cachedCarYesterday: null,
	carTotalYesterday: function() {
		if( Array.isArray(this.chargeHistory) && !this.cachedCarYesterday ) {
			let prevMidnight = new Date().setHours(-24,0,0,0);
			let midnight = new Date().setHours(0,0,0,0);
			this.cachedCarYesterday = this.chargeHistory.filter(
				entry => {
					let date = Date.parse(entry.timestamp);
					return date >= prevMidnight && date < midnight;
				}).reduce((total, next) => total + next.charger_power / 12, 0);
		}
		return this.cachedCarYesterday || 0;
	},

	notificationReceived: function(notification, payload, sender) {
		var self = this;
		if( !sender ) {
			// Received from core system
			if( notification === "MODULE_DOM_CREATED" ) {
				// DOM has been created, so hook up the graph objects
				self.buildGraphs()
			}
		}
		if( notification === "USER_PRESENCE" ) {
			if( payload ) {
				this.resume();
			}
			else {
				this.suspend();
			}
		}
	},

	dayNumber: -1,
	advanceDayMode: async function() {
		let now = new Date();
		let self = this;
		if( now.getDay() != this.dayNumber ) {
			this.dayNumber = now.getDay();
			this.sunrise = null;
			this.sunset = null;
			this.cachedCarYesterday = null;
			this.cachedCarTotal = null;

			if( now.getHours() == 0 && now.getMinutes() == 0 ) {
				// It's midnight
				this.updateSelfConsumption();
				if( this.dayStart ) {
					this.yesterdaySolar = (
						this.teslaAggregates.solar.energy_exported -
						this.dayStart.solar.export
					);
					this.yesterdayUsage = (
						this.teslaAggregates.load.energy_imported -
						this.dayStart.house.import
					);
				}
				this.dayStart = {
					solar: {
						export: this.teslaAggregates.solar.energy_exported
					},
					grid: {
						export: this.teslaAggregates.site.energy_exported,
						import: this.teslaAggregates.site.energy_imported
					},
					battery: {
						export: this.teslaAggregates.battery.energy_exported,
						import: this.teslaAggregates.battery.energy_imported
					},
					house: {
						import: this.teslaAggregates.load.energy_imported
					}
				};
			}
			else {
				this.dayStart = null;
			}
		}

		if( !this.dayStart ) {
			this.updateEnergy();
		}

		let riseset = {};
		if( (!this.sunrise || !this.sunset) && this.config.home ) {
			let url = "https://api.sunrise-sunset.org/json?lat=" +
				this.config.home[0] + "&lng=" + this.config.home[1] +
				"&formatted=0&date=" +
				[now.getFullYear(), now.getMonth() + 1, now.getDate()].join("-");
			let result = await fetch(url);
			if( result.ok ) {
				let response = await result.json();
				for( const tag of ["sunrise", "sunset"]) {
					if( response.results[tag] ) {
						riseset[tag] = Date.parse(response.results[tag]);
					}
				}
			}
		}
		this.sunrise = this.sunrise || riseset.sunrise || new Date().setHours(6,0,0,0);
		this.sunset = this.sunset || riseset.sunset || new Date().setHours(20,30,0,0);

		now = now.getTime();
		if( now < this.sunrise ) {
			this.dayMode = "morning";
		}
		else if( now > this.sunset ) {
			this.dayMode = "night";
		}
		else {
			this.dayMode = "day";
		}

		this.doTimeout("midnight", () => self.advanceDayMode(), new Date().setHours(24,0,0,0) - now, true);
	},

	buildGraphs: function() {
		this.Log("Rebuilding graphs");
		var self = this;

		Chart.helpers.merge(Chart.defaults.global, {
			responsive: true,
			maintainAspectRatio: true,
			legend: {
				display: false
			},
			aspectRatio: 1.12,
			elements: {
				arc: {
					borderWidth: 0
				}
			},
			tooltips: {
				enabled: false
			},
			plugins: {
				datalabels: {
					color: "white",
					textAlign: "center",
					clip: false,
					display: function(context) {
						return context.dataset.data[context.dataIndex] >= 0.5 ? "auto" : false;
					},
					labels: {
						title: {
							font: {
								size: 16,
								weight: "bold"
							}
						}
					},
					formatter: function(value, context) {
						return [
							context.dataset.labels[context.dataIndex],
							self.formatAsK(value, "W")
						];
					}
				}
			}
		});

		for( const oldChart in this.charts ) {
			this.charts[oldChart].destroy();
		}
		this.charts = {};

		if( this.flows ) {

			var myCanvas = document.getElementById(this.identifier + "-SolarDestinations");
			if( myCanvas ) {
				let distribution = this.flows.sources.solar.distribution;

				// Build the chart on the canvas
				var solarProductionPie = new Chart(myCanvas, {
					type: "pie",
					data: {
						datasets: [
							{
								data: DISPLAY_SINKS.map( (entry) => distribution[entry.key] ),
								backgroundColor: DISPLAY_SINKS.map( (entry) => entry.color ),
								weight: 2,
								labels: DISPLAY_SINKS.map( (entry) => entry.displayAs )
							},
							{
								data: [1],
								backgroundColor: SOLAR.color,
								weight: 1,
								showLine: false,
								datalabels: {
									labels: {
										title: null,
										value: null
									}
								}
							}
						]
					}
				});
				this.charts.solarProduction = solarProductionPie;
			}

			myCanvas = document.getElementById(this.identifier + "-HouseSources");
			if( myCanvas ) {
				let distribution = this.flows.sinks.house.sources;

				// Build the chart on the canvas
				var houseConsumptionPie = new Chart(myCanvas, {
					type: "pie",
					data: {
						datasets: [
							{
								data: DISPLAY_SOURCES.map( (entry) => distribution[entry.key] ),
								backgroundColor: DISPLAY_SOURCES.map( (entry) => entry.color ),
								weight: 2,
								labels: DISPLAY_SOURCES.map( (entry) => entry.displayAs )
							},
							{
								data: [1],
								backgroundColor: HOUSE.color,
								weight: 1,
								showLine: false,
								datalabels: {
									labels: {
										title: null,
										value: null
									}
								}
							}]
						}
					});
					this.charts.houseConsumption = houseConsumptionPie;
				}
			}

			myCanvas = document.getElementById(this.identifier + "-SelfPoweredDetails");
			if( myCanvas ) {
				let scSources = [SOLAR, POWERWALL, GRID];
				var selfConsumptionDoughnut = new Chart(myCanvas, {
					type: "doughnut",
					data: {
						datasets: [{
							data: this.selfConsumptionToday,
							backgroundColor: scSources.map( entry => entry.color),
							labels: scSources.map( entry => entry.displayAs ),
							datalabels: {
								formatter: function(value, context) {
									return [
										context.dataset.labels[context.dataIndex],
										Math.round(value) + "%"
									];
								}
							}
						}]
					},
					options: {
						cutoutPercentage: 65
					}
				});
				this.charts.selfConsumption = selfConsumptionDoughnut;
			}

			myCanvas = document.getElementById(this.identifier + "-EnergyBar");
			if( myCanvas && this.teslaAggregates ) {
				let data = this.dataTotals();
				// Horizontal bar chart here
				let energyBar = new Chart(myCanvas, {
					type: 'horizontalBar',
					data: {
						labels: DISPLAY_ALL.map(entry => entry.displayAs),
						datasets: [{
							backgroundColor: DISPLAY_ALL.map(entry => entry.color),
							borderColor: DISPLAY_ALL.map(entry => entry.color),
							borderWidth: 1,
							data: data
						}]
					},
					options: {
						// Elements options apply to all of the options unless overridden in a dataset
						// In this case, we are setting the border of each horizontal bar to be 2px wide
						elements: {
							rectangle: {
								borderWidth: 2,
							}
						},
						maintainAspectRatio: true,
						aspectRatio: 1.7,
						title: {
							display: false
						},
						plugins: {
							datalabels: false,
							annotation: {
								drawTime: 'afterDatasetsDraw',
								annotations: [{
									type: 'line',
									mode: 'vertical',
									scaleID: 'xAxis',
									value: 0,
									borderColor: 'black',
									borderWidth: 0.5,
									label: {
										enabled: false
									}
								}]
							}
						},
						scales: {
							xAxes: [{
								id: 'xAxis',
								ticks: {
									beginAtZero: true,
									callback: function( value, index, values) {
										if( value % 1000 == 0 ) {
											return Math.abs(value) / 1000;
										}
									},
									fontColor: "white",
									precision: 0,
									suggestedMax: 1000,
									suggestedMin: -1000
								},
								scaleLabel: {
									display: true,
									labelString: "Energy To / From (kWh)",
									fontColor: "white"
								}
							}],
							yAxes: [{
								ticks: {
									fontColor: "white"
								}
							}]
						}
					}
				});
				this.charts.energyBar = energyBar;
			}

			myCanvas = document.getElementById(this.identifier + "-PowerLine");
			if( myCanvas ) {
				let data = this.processPowerHistory();
				let powerLine = new Chart(myCanvas, {
					type: 'line',
					data: data,
					options: {
						// Elements options apply to all of the options unless overridden in a dataset
						// In this case, we are setting the border of each horizontal bar to be 2px wide
						elements: {
							point: {
								radius: 0
							}
						},
						maintainAspectRatio: true,
						aspectRatio: 1.7,
						spanGaps: false,
						title: {
							display: false
						},
						plugins: {
							datalabels: false
						},
						scales: {
							xAxes: [{
								type: "time",
								ticks: {
									min: new Date().setHours(0,0,0,0),
									max: new Date().setHours(24,0,0,0),
									fontColor: "white",
									autoSkipPadding: 10
								}
							}],
							yAxes: [{
								type: "linear",
								ticks: {
									callback: function( value, index, values) {
										if( value % 1000 == 0 ) {
											return Math.abs(value) / 1000;
										}
									},
									fontColor: "white",
									precision: 0
								},
								scaleLabel: {
									display: true,
									labelString: "Power To / From (kW)",
									fontColor: "white"
								}
							}]
						}
					}
				});
				this.charts.powerLine = powerLine;
			}
	},

	processPowerHistory: function() {
		// {
		// 	labels: DISPLAY_ALL.map(entry => entry.displayAs),
		// 	datasets: [{
		// 		backgroundColor: DISPLAY_ALL.map(entry => entry.color),
		// 		borderColor: DISPLAY_ALL.map(entry => entry.color),
		// 		borderWidth: 1,
		// 		data: data
		// 	}]
		// }
		if( this.powerHistory ) {
			let lastMidnight = new Date().setHours(0,0,0,0);
			let chargepoints = (this.chargeHistory || []).filter(
				entry => Date.parse(entry.timestamp) >= lastMidnight
			)
			let datapoints = this.powerHistory.filter(
				entry => Date.parse(entry.timestamp) >= lastMidnight
			).map(function(entry, index) {
				entry.charger_power = 0;
				if( chargepoints[index] ) {
					if( chargepoints[index].timestamp !== entry.timestamp ) {
						this.Log("Date mismatch, " + chargepoints[index].timestamp + " vs. " + entry.timestamp);
					}
					entry.car_power = -1 * chargepoints[index].charger_power
				}
				return entry
			});
			let entryVal = function(sample, entry) {
				if(sample) {
					switch(entry.key) {
						case "solar":
						case "battery":
						case "grid":
						case "car":
							return sample[entry.key + "_power"];
						case "house":
							// Positive
							let housePlusCar =
								sample.solar_power +
								sample.battery_power +
								sample.grid_power;
							if( Math.abs(sample.car_power) > housePlusCar ) {
								return -1 * housePlusCar;
							}
							else {
								return -1 * (housePlusCar + sample.car_power);
							}
						default:
							return 0;
					}
				}
				else {
					return 0;
				}
			}

			return {
				labels: datapoints.map(entry => entry.timestamp),
				datasets: DISPLAY_ALL.map(entry => {
					return {
						backgroundColor: entry.color_trans,
						borderColor: entry.color,
						borderWidth: 1,
						order: {
							solar: 5,
							battery: 4,
							grid: 3,
							house: 2,
							car: 1
						}[entry.key],
						data: datapoints.map((sample, index, array) => {
							let val = entryVal(sample, entry);
							return (
								val +
								entryVal(array[index-1], entry) +
								entryVal(array[index+1], entry)) != 0 ? val : null
						})
					};
				})
			};
		}
		else {
			return {
				labels: [],
				datasets: []
			}
		}
	},

	attributeFlows: function(teslaAggregates, twcConsumption) {
		if( teslaAggregates ) {
			let solar = Math.trunc(teslaAggregates.solar.instant_power);
			if( solar < 5 ) {
				solar = 0;
			}
			let battery = Math.trunc(teslaAggregates.battery.instant_power);
			if( Math.abs(battery) <= 20 ) {
				battery = 0;
			}
			let house = Math.trunc(teslaAggregates.load.instant_power);
			let car = 0;
			if( twcConsumption && twcConsumption <= house ) {
				car = twcConsumption;
				house -= car;
			}
			let grid = teslaAggregates.site.instant_power;			

			let flows = {
				solar: {
					unassigned: ((solar > 0) ? solar : 0),
					battery: 0,
					house: 0,
					car: 0,
					grid: 0
				},
				battery: {
					unassigned: ((battery > 0) ? battery : 0),
					house: 0,
					car: 0,
					grid: 0,
					battery: 0
				},
				grid: {
					unassigned: ((grid > 0) ? grid : 0),
					battery: 0,
					house: 0,
					car: 0,
					grid: 0
				},
				unassigned: {
					battery: ((battery < 0) ? Math.abs(battery) : 0),
					house: house,
					car: car,
					grid: ((grid < 0) ? Math.abs(grid) : 0)
				}
			}

			for( const source of DISPLAY_SOURCES.map((value) => value.key) ) {
				for( const sink of DISPLAY_SINKS.map((value) => value.key) ) {
					let amount_to_claim = Math.min(flows[source].unassigned, flows.unassigned[sink]);
					flows[source].unassigned -= amount_to_claim;
					flows.unassigned[sink] -= amount_to_claim;
					flows[source][sink] = amount_to_claim;
				}
				delete flows[source].unassigned;
			}

			let result = {
				sources: {},
				sinks: {}
			}

			for (const source of DISPLAY_SOURCES) {
				let target = {};
				let total = 0;
				target.distribution = flows[source.key]
				for( const sink of DISPLAY_SINKS) {
					total += flows[source.key][sink.key];
				}
				target.total = total;
				result.sources[source.key] = target;
			}
			for (const sink of DISPLAY_SINKS) {
				let target = {};
				let total = 0;
				target.sources = {};
				for( const source of DISPLAY_SOURCES) {
					total += flows[source.key][sink.key];
					target.sources[source.key] = flows[source.key][sink.key];
				}
				target.total = total;
				result.sinks[sink.key] = target;
			}
			return result;
		}
		else {
			return null;
		}
	},

	focusOnVehicles: async function(vehicles, numCharging) {
		// Makes the "car status" tile focus on particular vehicles
		// "vehicles" is a set
		// "numCharging" indicates how many cars are charging

		if( !vehicles ) {
			return;
		}

		// For the purposes of this function, it's sufficient to check length and equality of values
		let areVehiclesDifferent =
			vehicles.length !== this.displayVehicles.length ||
			vehicles.some( (newVehicle, index) => newVehicle !== this.displayVehicles[index] ) ||
			this.numCharging !== numCharging;

		if( this.numCharging !== numCharging ||
			this.vehicles.filter(
				vehicle => vehicle.charge &&
						   vehicle.charge.state === "Charging" &&
						   this.isHome(vehicle.drive.location)
			).length !== numCharging ) {
				// If numCharging has changed, or if it disagrees with the Tesla API, refresh
				this.numCharging = numCharging;
				this.updateVehicleData(30000);
		}

		if( areVehiclesDifferent ) {
			this.displayVehicles = vehicles;
			await this.advanceToNextVehicle();
		}
	},

	advanceToNextVehicle: async function() {
		let indexToFocus = (this.displayVehicles.indexOf(this.vehicleInFocus) + 1) % this.displayVehicles.length;
		let focusSameVehicle = false;
		if( this.displayVehicles.length === 0 ) {
			indexToFocus = -1;
		}
		else {
			focusSameVehicle = this.displayVehicles[indexToFocus] === this.vehicleInFocus;
		}

		if( indexToFocus >= 0 ) {
			let carTile = document.getElementById(this.identifier + "-CarTile");
			if( carTile ) {
				if( !focusSameVehicle ) {
					carTile.style.opacity = 0;
					await this.delay(500);
				}
				this.vehicleInFocus = this.displayVehicles[indexToFocus];
				await this.drawStatusForVehicle(this.vehicleInFocus, this.numCharging, !focusSameVehicle);
				if( !focusSameVehicle ) {
					carTile.style.opacity = 1;
				}
			}
		}
		else {
			// Should only happen if TWCManager reports cars charging, but no cars are identified as charging
			// Hopefully can resolve by polling for vehicle data more often, so we find the charging car.
			// If it's a friend's car, this won't work.
			this.updateVehicleData(30000);
		}
	},

	delay: function (ms) {
			return new Promise(resolve => setTimeout(resolve, ms));
	},

	createCompositorUrl: function(config) {
		let url = "https://static-assets.tesla.com/v1/compositor/?";
		let params = [
			"view=STUD_3QTR",
			"size=300",
			"bkba_opt=1"
		];
		let model_map = {
			"models": "ms",
			"modelx": "mx",
			"model3": "m3",
			"modely": "my"
		};
		params.push("model=" + model_map[config.car_type]);
		let options = config.option_codes.split(",");

		this.substituteOptions({
			"Pinwheel18": "W38B",
			"AeroTurbine20": "WT20",
			"Sportwheel19": "W39B",
			"Stiletto19": "W39B",
			"AeroTurbine19": "WTAS",
			"Turbine19": "WTTB",
			"Arachnid21Grey": "WTAB",
			"Performancewheel20": "W32P",
			"Stiletto20": "W32P",
			"AeroTurbine22": "WT22",
			"Super21Gray": "WTSG"
		}, config.wheel_type, options);

		this.substituteOptions({
			"ObsidianBlack": "PMBL",
			"SolidBlack": "PMBL",
			"MetallicBlack": "PMBL",
			"DeepBlueMetallic": "PPSB",
			"DeepBlue": "PPSB",
			"RedMulticoat": "PPMR",
			"Red": "PPMR",
			"MidnightSilverMetallic": "PMNG",
			"MidnightSilver": "PMNG",
			"SteelGrey": "PMNG",
			"SilverMetallic": "PMNG",
			"MetallicBrown": "PMAB",
			"Brown": "PMAB",
            "Silver": "PMSS",
            "TitaniumCopper": "PPTI",
            "DolphinGrey": "PMTG",
			"Green": "PMSG",
			"MetallicGreen": "PMSG",
			"PearlWhiteMulticoat":  "PPSW",
			"PearlWhite":  "PPSW",
			"Pearl": "PPSW",
			"SolidWhite": "PBCW",
			"White": "PBCW",
			"SignatureBlue": "PMMB",
			"MetallicBlue": "PMMB",
            "SignatureRed": "PPSR",
		}, config.exterior_color, options);

		params.push("options=" + options.join(","));
		url += params.join("&");
		return url;
	},

	substituteOptions: function(map, value, options) {
		if( map[value] ) {
			for( const option of Object.values(map) ) {
				let toRemove = options.indexOf(option);
				if( toRemove >= 0 ) {
					options.splice(toRemove, 1);
				}
			}
			options.push(map[value]);
		}
		else {
			this.Log("Unknown vehicle trait encountered: " + value);
		}
	}
});
