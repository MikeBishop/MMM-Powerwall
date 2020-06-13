/* Magic Mirror
 * Module: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

const SOLAR = { key: "solar", displayAs: "Solar", color: "gold" };
const POWERWALL = { key: "battery", displayAs: "Powerwall", color: "#0BC60B"};
const GRID = { key: "grid", displayAs: "Grid", color: "#CACECF" };
const HOUSE = { key: "house", displayAs: "Local Usage", color: "#09A9E6" };
const CAR = { key: "car", displayAs: "Car Charging", color: "#B91413" };

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
	teslaAPIEnabled: null,
	teslaAggregates: null,
	flows: null,
	historySeries: null,
	numCharging: 0,
	yesterdaySolar: null,
	dayStart: {
		grid: null,
		solar: null,
		battery: null,
		house: null,
	},
	dayMode: "day",
	todayDate: null,
	charts: {},
	selfConsumptionToday: [0, 0, 100],
	selfConsumptionYesterday: null,
	soe: 0,
	vehicles: null,
	displayVehicles: [],
	vehicleInFocus: null,
	vehicleTileShown: "A",

	start: function() {
		var self = this;

		//Flag for check if module is loaded
		this.loaded = false;

		if (self.config.twcManagerIP) {
			self.twcEnabled = true;
		}
		else {
			self.twcEnabled = false;
		}
		
		//Send settings to helper
		if (self.config.teslaAPIUsername && self.config.teslaAPIPassword ) {
			self.sendSocketNotification("MMM-Powerwall-Configure-TeslaAPI",
			{
				updateInterval: self.config.cloudUpdateInterval,
				siteID: self.config.siteID,
				teslaAPIUsername: self.config.teslaAPIUsername,
				teslaAPIPassword: self.config.teslaAPIPassword,
				tokenFile: this.file("tokens.json")
			});
			Log.log("Enabled Tesla API");
		}
		else {
			self.teslaAPIEnabled = false;
		}
		var updateLocal = function() {
			self.sendSocketNotification("MMM-Powerwall-UpdateLocal", {
				powerwallIP: self.config.powerwallIP,
				twcManagerIP: self.config.twcManagerIP,
				twcManagerPort: self.config.twcManagerPort,
				updateInterval: self.config.localUpdateInterval
			});
		};

		setInterval(updateLocal, self.config.localUpdateInterval);
		setInterval(function() {
			self.advanceToNextVehicle();
		}, 20000);
		updateLocal();
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
		if( this.teslaAPIEnabled ) {
			this.sendSocketNotification("MMM-Powerwall-UpdateEnergy", {
				username: this.config.teslaAPIUsername,
				siteID: this.config.siteID,
				updateInterval: this.config.cloudUpdateInterval
			});
		}
	},

	sendDataRequestNotification: function(notification) {
		if( this.teslaAPIEnabled ) {
			this.sendSocketNotification(notification, {
				username: this.config.teslaAPIUsername,
				siteID: this.config.siteID,
				updateInterval: this.config.cloudUpdateInterval
			});
		}
	},

	updatePowerHistory: function() {
		this.sendDataRequestNotification("MMM-Powerwall-UpdatePowerHistory");
	},

	updateSelfConsumption: function() {
		this.sendDataRequestNotification("MMM-Powerwall-UpdateSelfConsumption");
	},

	updateVehicleData: function(timeout=null) {
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
					updateInterval: timeout
				});
			}
		}
	},

	// socketNotificationReceived from helper
	socketNotificationReceived: async function (notification, payload) {
		var self = this;
		Log.log("Received " + notification + ": " + JSON.stringify(payload));
		switch(notification) {
			case "MMM-Powerwall-TeslaAPIConfigured":
				if( payload.username === self.config.teslaAPIUsername ) {
					if( !self.config.siteID ) {
						self.config.siteID = payload.siteID;
					}
					if( self.config.siteID === payload.siteID ) {
						self.teslaAPIEnabled = true;
						this.updateEnergy();
						this.updateSelfConsumption();
						this.updatePowerHistory();
						setInterval(function() {
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

					let todayDate = new Date().getDate();
					if( this.todayDate !== todayDate ) {
						if( this.dayStart.solar ) {
							this.yesterdaySolar = (
								this.teslaAggregates.solar.energy_exported -
								this.dayStart.solar.export
							);
						}
						this.updateEnergy();
						this.todayDate = todayDate;
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

					if (needUpdate) {
						// If we didn't have data before, we need to redraw
						this.buildGraphs();
					}

					// We're updating the data in-place.
					this.updateData();
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
						this.updateData();
					}

					if( payload.status.carsCharging > 0 && this.vehicles ) {
						// Charging at least one car
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
						Log.log(JSON.stringify(this.dayStart));

						this.todayDate = new Date().getDate();
				}
				break;
			case "MMM-Powerwall-PowerHistory":
				if( payload.username === this.config.teslaAPIUsername &&
					this.config.siteID == payload.siteID ) {
						this.powerHistory = payload.powerHistory;
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
				let minutes = Math.trunc(
					(statusFor.charge.time - Math.trunc(statusFor.charge.time))
					* 60);
				if( statusFor.charge.time >= 1 ) {
					let hours = Math.trunc(statusFor.charge.time);
					timeText = hours > 2 ? (hours + " hours ") : "1 hour ";
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

	updateData: function() {
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
		if( this.dayStart.solar ) {
			this.updateNode(
				this.identifier + "-SolarTotalA",
				this.teslaAggregates.solar.energy_exported - this.dayStart.solar.export,
				"Wh"
			);
			this.updateNode(
				this.identifier + "-SolarTotalB",
				this.dayMode === "morning" ?
				this.yesterdaySolar : 
				(this.teslaAggregates.solar.energy_exported - this.dayStart.solar.export),
				"Wh"
			);
		}
		let solarFlip = document.getElementById(this.identifier + "-SolarFlip");
		let solarCanvas = document.getElementById(this.identifier + "-SolarDestinations");
		if( solarFlip && solarCanvas ) {
			if( this.dayMode === "day" ) {
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

		/********************
		 * HouseConsumption *
		 ********************/
		this.updateNode(this.identifier + "-HouseConsumption", this.flows.sinks.house.total, "W");
		this.updateChart(this.charts.houseConsumption, DISPLAY_SOURCES, this.flows.sinks.house.sources);
		if( this.dayStart.house ) {
			this.updateNode(
				this.identifier + "-UsageTotal",
				this.teslaAggregates.load.energy_imported - this.dayStart.house.import,
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

		/********************
		 * Self-Consumption *
		 ********************/
		if( this.selfConsumptionToday ) {
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

		/****************
		 * Car Charging *
		 ****************/
		let charging = this.flows.sinks.car.total;
		if( this.numCharging > 0 ) {
			for( const suffix of ["A", "B"]) {
				this.updateNode(this.identifier + "-CarConsumption-" + suffix, charging, "W", "", this.vehicleTileShown == suffix);
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

		let powerLine = this.charts.powerLine;
		if( powerLine && this.powerHistory ) {
			powerLine.options.scales.xAxes[0].ticks.min = new Date().setHours(0,0,0);
			powerLine.data = this.processPowerHistory();
			powerLine.update();
		}
	},

	dataTotals: function() {
		return [
			// Grid out/in
			[
				-1 * (
					this.teslaAggregates.site.energy_exported -
					this.dayStart.grid.export),
				this.teslaAggregates.site.energy_imported - this.dayStart.grid.import
			],
			// Battery out/in
			[
				-1 * (
					this.teslaAggregates.battery.energy_exported -
					this.dayStart.battery.export),
				this.teslaAggregates.battery.energy_imported - this.dayStart.battery.import
			],
			// House out (TODO:  Includes car)
			[
				-1 * (
					this.teslaAggregates.load.energy_imported -
					this.dayStart.house.import),
				0
			],
			// Car out - TODO
			[0,0],
			// Solar in
			[
				0,
				this.teslaAggregates.solar.energy_exported -
				this.dayStart.solar.export
			]
		]
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
		else if ( notification === "CURRENTWEATHER_DATA" ) {
			let data = payload.data;
			let sunrise = new Date(data.sys.sunrise * 1000);
			let sunset = new Date(data.sys.sunset * 1000);
			let now = new Date();

			this.sunrise = sunrise.getHours() + ":" + sunrise.getMinutes();

			let newMode = "";
			if (now < sunrise) {
				newMode = "morning";
			}
			else if (sunset < now) {
				newMode = "night";
			}
			else {
				newMode = "day";
			}
			if( newMode != this.dayMode ) {
				this.dayMode = newMode;
				this.updateEnergy();
				// I don't think this is needed any more; TEST.
				//this.updateDom();
			}
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
			aspectRatio: 1.1,
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
					anchor: "center",
					textalign: "center",
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
			if( myCanvas && this.teslaAggregates && this.dayStart ) {
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
										return Math.round(Math.abs(value) / 1000);
									},
									fontColor: "white"
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
									min: new Date().setHours(0,0,0),
									fontColor: "white",
									autoSkipPadding: 10
								}
							}],
							yAxes: [{
								ticks: {
									callback: function( value, index, values) {
										return Math.round(Math.abs(value) / 1000);
									},
									fontColor: "white"
								},
								scaleLabel: {
									display: true,
									labelString: "Power To / From (kW)",
									fontColor: "white"
								}
							}]
						},
						animation: {
							duration: 0
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

			return {
				labels: this.powerHistory.map(entry => entry.timestamp),
				datasets: DISPLAY_ALL.map(entry => {
					return {
						backgroundColor: entry.color,
						borderColor: entry.color,
						borderWidth: 1,
						data: this.powerHistory.map(sample => {
							switch(entry.key) {
								case "solar":
									case "battery":
								case "grid":
									return sample[entry.key + "_power"];
									case "car":
										return 0;
								case "house":
									return -1 * (
										sample.solar_power +
										sample.battery_power +
										sample.grid_power
										);
								default:
									return null;
							}
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
			if( twcConsumption ) {
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

	delay: function (ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
});
