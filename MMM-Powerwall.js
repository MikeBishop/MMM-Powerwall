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
const DISPLAY_ALL = [
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
		home: null
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
	dayStart: null,
	dayMode: "day",
	energyData: null,
	charts: {},
	powerHistoryChanged: false,
	selfConsumptionToday: [0, 0, 100],
	selfConsumptionYesterday: null,
	soe: 0,
	vehicles: null,
	displayVehicles: [],
	vehicleInFocus: null,
	vehicleTileShown: "A",
	cloudInterval: null,

	start: async function() {
		var self = this;

		//Flag for check if module is loaded
		this.loaded = false;

		if (self.config.twcManagerIP) {
			self.twcEnabled = true;
		}
		else {
			self.twcEnabled = false;
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
			Log.log("Enabled Tesla API");
		}
		var updateLocal = function() {
			if( self.callsToEnable.local ) {
				let config = self.config;
				self.sendSocketNotification("MMM-Powerwall-UpdateLocal", {
					powerwallIP: config.powerwallIP,
					twcManagerIP: config.twcManagerIP,
					twcManagerPort: config.twcManagerPort,
					updateInterval: config.localUpdateInterval - 500,
					username: config.teslaAPIUsername,
					siteID: config.siteID,
					resyncInterval: config.cloudUpdateInterval - 500
				});
			}
		};

		setInterval(updateLocal, self.config.localUpdateInterval);
		setInterval(function() {
			self.advanceToNextVehicle();
		}, 20000);
		updateLocal();
		await this.advanceDayMode();
	},

	configureTeslaApi: function() {
		if (this.config.teslaAPIUsername ) {
			this.sendSocketNotification("MMM-Powerwall-Configure-TeslaAPI",
			{
				siteID: this.config.siteID,
				teslaAPIUsername: this.config.teslaAPIUsername,
				teslaAPIPassword: this.config.teslaAPIPassword,
				tokenFile: this.file("tokens.json")
			});
			Log.log("Enabled Tesla API");
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

		Log.log("Returning " + JSON.stringify(result));
		return result;
	},

	getScripts: function() {
		return [
			this.file("node_modules/chart.js/dist/Chart.bundle.js"),
			this.file("node_modules/chartjs-plugin-datalabels/dist/chartjs-plugin-datalabels.min.js"),
		];
	},

	getStyles: function () {
		return [
			"MMM-Powerwall.css",
		];
	},

	updateEnergy: function() {
		if( this.callsToEnable.energy &&
			this.teslaAPIEnabled && this.config.siteID ) {
			this.sendSocketNotification("MMM-Powerwall-UpdateEnergy", {
				username: this.config.teslaAPIUsername,
				siteID: this.config.siteID,
				updateInterval: this.config.cloudUpdateInterval - 500
			});
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
			this.sendDataRequestNotification("MMM-Powerwall-UpdatePowerHistory");
			if( this.twcEnabled ) {
				this.sendSocketNotification("MMM-Powerwall-UpdateChargeHistory", {
					twcManagerIP: this.config.twcManagerIP,
					twcManagerPort: this.config.twcManagerPort,
					updateInterval: this.config.localUpdateInterval - 500
				});
			}
		}
	},

	updateSelfConsumption: function() {
		if( this.callsToEnable.selfConsumption ) {
			this.sendDataRequestNotification("MMM-Powerwall-UpdateSelfConsumption");
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

					this.sendSocketNotification("MMM-Powerwall-UpdateVehicleData", {
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
		Log.log("Received " + notification + ": " + JSON.stringify(payload));
		switch(notification) {
			case "MMM-Powerwall-ReconfigureTeslaAPI":
				if( payload.teslaAPIUsername == self.config.teslaAPIUsername ) {
					this.configureTeslaApi();
				}
				break;
			case "MMM-Powerwall-TeslaAPIConfigured":
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
						if( this.cloudInterval ) {
							clearInterval(this.cloudInterval);
						}
						this.cloudInterval = setInterval(function() {
							self.updateSelfConsumption();
							self.updatePowerHistory();
						}, this.config.cloudUpdateInterval);
					}
					this.vehicles = payload.vehicles;
					this.updateVehicleData();
					setInterval(function() {
						self.updateVehicleData();
					}, self.config.cloudUpdateInterval);
					await this.focusOnVehicles(this.vehicles, 0);
				}
				break;

			case "MMM-Powerwall-Aggregates":
				if( payload.ip === this.config.powerwallIP ) {
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
			case "MMM-Powerwall-SOE":
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
			case "MMM-Powerwall-ChargeStatus":
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
						for( const suffix of ["A", "B"]) {
							this.updateNode(this.identifier + "-CarConsumption-" + suffix, charging, "W", "", this.vehicleTileShown == suffix);
						}

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
									knownVehicle.charge.charging_state === "Charging"
							);
						}
						await this.focusOnVehicles(vehicles, payload.status.carsCharging)
					}
					else {
						// No cars are charging.
						await this.focusOnVehicles(this.vehicles, 0);
					}
				}
				break;

			case "MMM-Powerwall-EnergyData":
				if( payload.username === this.config.teslaAPIUsername &&
					this.config.siteID == payload.siteID ) {

					this.yesterdaySolar = payload.energy[0].solar_energy_exported;

					if( this.teslaAggregates ) {
						this.generateDaystart(payload);
					}
					else {
						this.energyData = payload
					}
				}
				break;
			case "MMM-Powerwall-PowerHistory":
				if( payload.username === this.config.teslaAPIUsername &&
					this.config.siteID == payload.siteID ) {
						this.powerHistory = payload.powerHistory;
						this.updatePowerLine();
				}
				break;
			case "MMM-Powerwall-ChargeHistory":
				if( payload.twcManagerIP === this.config.twcManagerIP ) {
					this.chargeHistory = payload.chargeHistory;
					this.cachedCarTotal = null;
					this.updatePowerLine();
				}
				break;
			case "MMM-Powerwall-SelfConsumption":
				if( payload.username === this.config.teslaAPIUsername &&
					this.config.siteID == payload.siteID ) {
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
							"%");
						let scChart = this.charts.selfConsumption
						if( scChart ) {
							scChart.data.datasets[0].data = this.selfConsumptionToday;
							scChart.update();
						}
				}
				break;
			case "MMM-Powerwall-VehicleData":
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
					let statusFor = this.vehicles.find(vehicle => vehicle.id == payload.ID);
					if( statusFor.drive ) {
						statusFor.oldLocation = statusFor.drive.location;
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
						await this.drawStatusForVehicle(statusFor, this.numCharging, this.vehicleTileShown);
					}
				}
				break;
			default:
				break;
		}
	},

	generateDaystart: function(payload) {
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

	drawStatusForVehicle: async function(statusFor, numCharging, suffix) {
		if( !statusFor || !statusFor.drive ) {
			return false;
		}

		let statusText = statusFor.display_name;
		let animate = suffix === this.vehicleTileShown;
		let number = 0;
		let unit = "W";
		let consumptionVisible;
		let addLocation = false;
		let consumptionId = this.identifier + "-CarConsumption-" + suffix;
		let completionParaId = this.identifier + "-CarCompletionPara-" + suffix;

		let picture = document.getElementById(this.identifier + "-Picture-" + suffix);
		if( picture && statusFor.imageUrl ) {
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
				this.updateText(this.identifier + "-CarCompletion-" + suffix, timeText, animate);
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
						number =  statusFor.drive.speed;
					}
					else {
						// Convert to kph, since API reports mph
						number = statusFor.drive.speed * 1.609344;
					}
					consumptionVisible = true;

					break;
				
				default:
					statusText += " parked";
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
				if (statusFor.oldLocation && statusFor.locationText &&
					this.isSameLocation(statusFor.oldLocation, statusFor.drive.location)) {
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
							}
						}
					}
					catch {
						statusFor.locationText = null;
					}
				}
			}
			this.makeNodeInvisible(completionParaId);
		}
		
		this.updateText(this.identifier + "-CarStatus-" + suffix, statusText, animate);
		let meterNode = document.getElementById(this.identifier + "-car-meter-" + suffix);
		if( meterNode ) {
			meterNode.style.width = statusFor.charge.soc + "%";
		}
		this.updateNode(
			this.identifier + "-car-meter-text-" + suffix,
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

		/*******************
		 * SolarProduction *
		 *******************/
		this.updateNode(
			this.identifier + "-SolarProduction",
			this.flows.sources.solar.total,
			"W",
			"",
			this.dayMode === "day"
		);
		this.updateChart(this.charts.solarProduction, DISPLAY_SINKS, this.flows.sources.solar.distribution);
		let solarFlip = document.getElementById(this.identifier + "-SolarFlip");
		let solarCanvas = document.getElementById(this.identifier + "-SolarDestinations");
		let focusOnA = this.dayMode === "day";
		if( solarFlip && solarCanvas ) {
			if( focusOnA ) {
				solarFlip.style.transform = "none";
				solarCanvas.style.visibility = "visible"
			}
			else {
				solarFlip.style.transform = "rotateX(180deg)";
				solarCanvas.style.visibility = "hidden";
				this.updateText(
					this.identifier + "-SolarTodayYesterday",
					this.dayMode === "morning" ? "yesterday" : "today"
				);
			}
		}
		if( this.dayStart ) {
			this.makeNodeVisible(this.identifier + "-SolarTotalTextA");
			this.updateNode(
				this.identifier + "-SolarTotalA",
				this.teslaAggregates.solar.energy_exported - this.dayStart.solar.export,
				"Wh", "", focusOnA
			);
			this.updateNode(
				this.identifier + "-SolarTotalB",
				this.dayMode === "morning" ?
				this.yesterdaySolar :
				(this.teslaAggregates.solar.energy_exported - this.dayStart.solar.export),
				"Wh", "", !focusOnA
			);
		}


		/********************
		 * HouseConsumption *
		 ********************/
		this.updateNode(this.identifier + "-HouseConsumption", this.flows.sinks.house.total, "W");
		this.updateChart(this.charts.houseConsumption, DISPLAY_SOURCES, this.flows.sinks.house.sources);
		if( this.dayStart ) {
			this.updateNode(
				this.identifier + "-UsageTotal",
				this.teslaAggregates.load.energy_imported - this.dayStart.house.import - this.carTotalToday(),
				"Wh today"
			);
		}

		/*******************
		 * Powerwall Meter *
		 *******************/
		let battery = this.teslaAggregates.battery.instant_power;
		let targetId = this.identifier + "-PowerwallStatus";
		if( battery != 0) {
			this.updateNode(
				targetId,
				Math.abs(this.teslaAggregates.battery.instant_power),
				"W",
				this.teslaAggregates.battery.instant_power > 0 ? "Supplying " : "Charging at ",
				false
			);
		}
		else {
			this.updateText(targetId, "Standby");
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
			return [
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
			]
		}
		else {
			return Array(5).fill(Array(2).fill(0));
		}
	},

	cachedCarTotal: null,
	carTotalToday: function() {
		if( Array.isArray(this.chargeHistory) && !this.cachedCarTotal ) {
			this.cachedCarTotal = this.chargeHistory.filter(
				entry => Date.parse(entry.timestamp) >= new Date().setHours(0,0,0,0)
			).reduce((total, next) => total + next.charger_power / 12, 0)
		}
		return this.cachedCarTotal
	},

	notificationReceived: function(notification, payload, sender) {
		var self = this;
		if( !sender ) {
			// Received from core system
			if( notification === "MODULE_DOM_CREATED" ) {
				// DOM has been created -- container will be consistent, but children may be recreated
				var myDiv = document.getElementById(this.identifier);
				for( const node of myDiv.children ) {
					if( node.classList.contains("module-content") ) {
						// Here's the content div, which we need to observe
						const config = {attributes: false, childList: true, subtree: false };
						this.observer = new MutationObserver(function(mutationsList, observer) {self.buildGraphs(); });
						this.observer.observe(node, config);
						
						// Need to trigger it the first time
						self.buildGraphs()
						break;
					}
					else {
						Log.log("Found a non-match")
					}
				}
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

			if( now.getHours() == 0 && now.getMinutes() == 0 ) {
				// It's midnight
				if( this.dayStart ) {
					this.yesterdaySolar = (
						this.teslaAggregates.solar.energy_exported -
						this.dayStart.solar.export
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
				"&formatted=0";
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
		this.sunrise = this.sunrise || riseset.sunrise || new Date().setHours(6,0,0,0).getTime();
		this.sunset = this.sunset || riseset.sunset || new Date().setHours(20,30,0).getTime();

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
	},

	buildGraphs: function() {
		Log.log("Rebuilding graphs");
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
							datalabels: false
						},
						scales: {
							xAxes: [{
								ticks: {
									beginAtZero: true,
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
						Log.log("Date mismatch, " + chargepoints[index].timestamp + " vs. " + entry.timestamp);
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
							return -1 * (
								sample.solar_power +
								sample.battery_power +
								sample.grid_power +
								sample.car_power
								);
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
			let battery = Math.trunc(teslaAggregates.battery.instant_power);
			let house = Math.trunc(teslaAggregates.load.instant_power);
			let car = 0;
			if( twcConsumption && twcConsumption >= house ) {
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

		if( this.numCharging !== numCharging ) {
			this.updateVehicleData(30);
		}

		if( areVehiclesDifferent ) {
			this.displayVehicles = vehicles;
			this.numCharging = numCharging;
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
			let newTileSide;
			if( focusSameVehicle ) {
				newTileSide = this.vehicleTileShown;
			}
			else {
				newTileSide = (this.vehicleTileShown === "A" ? "B" : "A");
			}
			let drew = await this.drawStatusForVehicle(this.displayVehicles[indexToFocus], this.numCharging, newTileSide);
			if( !focusSameVehicle && drew ) {
				this.vehicleInFocus = this.displayVehicles[indexToFocus];
				this.vehicleTileShown = newTileSide;
				let carFlip = document.getElementById(this.identifier + "-CarFlip");
				if( carFlip ) {
					carFlip.style.transform = (this.vehicleTileShown === "A" ? "none" : "rotateX(180deg)");
				}
			}
		}
		else {
			// Should only happen if TWCManager reports cars charging, but no cars are identified as charging
			// Hopefully can resolve by polling for vehicle data more often, so we find the charging car.
			// If it's a friend's car, this won't work.
			this.updateVehicleData(30);
		}
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
			Log.log("Unknown vehicle trait encountered: " + value);
		}
	}
});
