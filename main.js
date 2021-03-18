"use strict";

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

// Load your modules here, e.g.:
const got = require("got");
const formData = require("form-data");

if (!Number.prototype.round) {
	Number.prototype.round = function (decimals) {
		if (typeof decimals === "undefined") {
			decimals = 0;
		}
		return Math.round(
			this * Math.pow(10, decimals)
		) / Math.pow(10, decimals);
	};
}

class Controme extends utils.adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "controme",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and this received configuration.
	 */
	async onReady() {
		// Initialize your this here

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		// check the received configuration values for validity
		if (this.config.interval < 15) {
			this.log.error("Update interval is less than 15 seconds. Set update interval to 15 seconds.");
			this.config.interval = 15;
		}

		this.log.debug(`Controme URL: ${this.config.url}; houseID: ${this.config.houseID}; update interval: ${this.config.interval}`);

		if (this.config.forceReInit) {
			this.log.debug("Re-initializing object structure.");

			try {
				const objects = await this.getAdapterObjectsAsync();

				for (const object in objects) {
					if (Object.prototype.hasOwnProperty.call(objects, object)) {
						await this.delForeignObjectAsync(object);
					}
				}

			} catch (error) {
				this.log.error(error);
			}

			try {
				await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { forceReInit: false } });
			} catch (e) {
				this.log.error(`Could not set forceReinit to false: ${e.message}`);
			}
		}

		// Upon initialization of the this, the adapter reads the room structure and creates all rooms that do not yet exist
		(async () => {
			const url = "http://" + this.config.url + "/get/json/v1/" + this.config.houseID + "/rooms/";
			try {
				const response = await got(url);

				// response JSON contains hierarchical information starting with floors and rooms on these floors
				// we need to iterate through the floors and rooms and create the required structures
				// rooms will be our devices

				const body = JSON.parse(response.body);
				// this.log.silly(`Rooms response from Controme mini server: "${JSON.stringify(body)}"`);

				for (const floor in body) {
					if (Object.prototype.hasOwnProperty.call(body, floor)) {
						for (const room in body[floor].raeume) {
							if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
								this._createObjectsForRoom(body[floor].raeume[room]);
							}
						}
					}
				}

			} catch (error) {
				this.log.error(`Reading room structure from Controme mini server finished with error "${error.response.body}"`);
			}
		})();

		// Start polling temperature data from the server in the defined update interval
		this.updateInterval = setInterval(() => {
			this.log.debug("Polling temperature data from mini server");
			const url = "http://" + this.config.url + "/get/json/v1/1/temps/";
			(async () => {
				try {
					const response = await got(url);

					const body = JSON.parse(response.body);
					// this.log.silly(`Temps response from Controme mini server: "${JSON.stringify(body)}"`);

					for (const floor in body) {
						if (Object.prototype.hasOwnProperty.call(body, floor)) {
							for (const room in body[floor].raeume) {
								if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
									this._updateRoom(body[floor].raeume[room]);
									// Create offsets for the respective room; offset data is only transmitted by the temps API call or the roomoffsets API call 
									// (where the offset data is fully included in temps), so creating this structure cannot be done when we create the rooms earlier. 
									// this.log.debug(JSON.stringify(room.offsets));
									// this._createOffsetsForRoom(room.id, room.offsets);

									// Create sensors for the respective room; sensor data is only transmitted by the temps API call, 
									// so cannot be done when we create the rooms earlier. 
									for (const sensor in body[floor].raeume[room].sensoren) {
										if (Object.prototype.hasOwnProperty.call(body[floor].raeume[room].sensoren, sensor)) {
											// [CHECK] If it is a performance issue to do this every time, this should only be done when forceReInit is set in admin
											this._createSensorsForRoom(body[floor].raeume[room].id, body[floor].raeume[room].sensoren[sensor]);
											this._updateSensorsForRoom(body[floor].raeume[room].id, body[floor].raeume[room].sensoren[sensor]);
										}
									}
								}
							}
						}
					}
					// the connection indicator is updated when the connection was successful
					this.setStateAsync("info.connection", true, true);
				} catch (error) {
					// when an error is received, the connection indicator is updated accordingly
					this.setStateAsync("info.connection", false, true);
					this.log.info(`Polling temperature data from Controme mini server finished with error "${error.response.body}"`);
				}
			})();

		}, this.config.interval * 1000);

		// Subscribe to all states that can be written to
		this.subscribeStates("*.setPointTemperature");
		this.subscribeStates("*.sensor.*.actualTemperature");

		this.setState("info.connection", true, true);

	}

	_createObjectsForRoom(room) {
		const promises = [];
		promises.push(this.setObjectNotExistsAsync(room.id.toString(), { type: "device", common: { name: room.name }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".actualTemperature", { type: "state", common: { name: room.name + ".actualTemperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".setPointTemperature", { type: "state", common: { name: room.name + ".setPointTemperature", type: "number", unit: "°C", role: "level.temperature", read: true, write: true }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(room.id + ".temperatureOffset", { type: "state", common: { name: room.name + ".temperatureOffset", type: "number", unit: "°C", role: "value", read: true, write: false }, native: {} }));
		return Promise.all(promises);
	}

	_createOffsetsForRoom(roomID, offsets) {
		for (const offset in offsets) {
			this.log.debug(offset);
			// if (Object.prototype.hasOwnProperty.call(offsets, offset)) {
			// 	this.log.debug(`${offset}: ${JSON.stringify(offsets[offset])}`);
			// 	// this.log.debug(`${offset} : ${JSON.stringify(offset)}`);
			// 	// [CHECK] If it is a performance issue to do this every time, this should only be done when forceReInit is set in admin
			// 	// this._updateOffsetsForRoom(body[floor].raeume[room], body[floor].raeume[room].offsets[offset]);
			// }
		}

		// const promises = [];
		// promises.push(this.setObjectNotExistsAsync(room.id + ".offsets." + sensor.name, { type: "device", common: { name: sensor.beschreibung }, native: {} }));
		// promises.push(this.setObjectNotExistsAsync(room.id + ".offsets." + sensor.name + ".isRoomTempSensor", { type: "state", common: { name: sensor.beschreibung + ".isRoomTempSensor", type: "boolean", role: "indicator", read: true, write: false }, native: {} }));
		// promises.push(this.setObjectNotExistsAsync(room.id + ".offsets." + sensor.name + ".actualTemperature", { type: "state", common: { name: sensor.beschreibung + ".actualTemperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: true }, native: {} }));
		// return Promise.all(promises);
	}

	_createSensorsForRoom(roomID, sensor) {
		const promises = [];
		promises.push(this.setObjectNotExistsAsync(roomID + ".sensors." + sensor.name, { type: "device", common: { name: sensor.beschreibung }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(roomID + ".sensors." + sensor.name + ".isRoomTempSensor", { type: "state", common: { name: sensor.beschreibung + ".isRoomTempSensor", type: "boolean", role: "indicator", read: true, write: false }, native: {} }));
		promises.push(this.setObjectNotExistsAsync(roomID + ".sensors." + sensor.name + ".actualTemperature", { type: "state", common: { name: sensor.beschreibung + ".actualTemperature", type: "number", unit: "°C", role: "value.temperature", read: true, write: true }, native: {} }));
		return Promise.all(promises);
	}

	_updateRoom(room) {
		const promises = [];
		this.log.silly(`Updating room ${room.id} (${room.name})`);
		promises.push(this.setStateChangedAsync(room.id + ".actualTemperature", parseFloat(room.temperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".setPointTemperature", parseFloat(room.solltemperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".temperatureOffset", parseFloat(room.total_offset).round(2), true));
		return Promise.all(promises);
	}

	hasJsonStructure(str) {
		if (typeof str !== 'string') return false;
		try {
			const result = JSON.parse(str);
			const type = Object.prototype.toString.call(result);
			return type === '[object Object]'
				|| type === '[object Array]';
		} catch (err) {
			return false;
		}
	}

	_updateSensorsForRoom(roomID, sensor) {
		const promises = [];
		promises.push(this.setStateChangedAsync(roomID + ".sensors." + sensor.name + ".isRoomTempSensor", sensor.raumtemperatursensor));
		// sensor.wert can be either an object or a float
		if (typeof (sensor.wert) === "object") {
			this.log.silly(`Updating sensor ${sensor.name} (${sensor.beschreibung}) for room ${roomID} to ${sensor.wert.Temperatur} °C`);
			promises.push(this.setStateChangedAsync(roomID + ".sensors." + sensor.name + ".actualTemperature", parseFloat(sensor.wert.Temperatur).round(2), true));
		} else {
			this.log.silly(`Updating sensor ${sensor.name} (${sensor.beschreibung}) for room ${roomID} to ${sensor.wert} °C`);
			promises.push(this.setStateChangedAsync(roomID + ".sensors." + sensor.name + ".actualTemperature", parseFloat(sensor.wert).round(2), true));
		}
		return Promise.all(promises);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.debug("Stopping update interval.");
			// Here you must clear all timeouts or intervals that may still be active
			clearInterval(this.updateInterval);
			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// A subscribed state was changed. We need to only react on changes initiated by the used, where ack == false
			if (state.ack == false) {
				this.log.debug(`State ${id} changed: ${state.val} (ack = ${state.ack})`);
				// identify which of the subscribed states has changed
				if (id.endsWith(".setPointTemperature")) {
					// extract the roomID from id
					const roomID = id.match(/\.(\d+)\.\w+$/);
					if (roomID !== null) {
						this._setPointTemp(roomID[1], state.val);
					}
				} else if (id.endsWith(".actualTemperature")) {
					// extract the sensorID from id
					const sensorID = id.match(/\.sensor\.([0-9a-f_:]+)\.\w+$/);
					if (sensorID !== null) {
						this.log.debug(`Sensor ID ${sensorID[1]}`);
						this._setActualTemp(sensorID[1], state.val);
					}
				}
			}
		} else {
			// The state was deleted
			this.log.debug(`state ${id} deleted`);
		}
	}

	_setPointTemp(roomID, setPointTemp) {
		this.log.debug(`Setting setpoint temperature on Controme mini server for room ${roomID} to ${setPointTemp}`);
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/soll/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		form.append("soll", setPointTemp);

		(async () => {
			try {
				await got.post(url, { body: form });
			} catch (error) {
				this.log.error(error);
			}
		})();
	}

	_setTargetTemp(roomID, targetTemp, targetDuration) {
		this.log.debug(`Setting target temperature on Controme mini server for room ${roomID} to ${targetTemp} for ${targetDuration} minutes`);
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/ziel/" + roomID + "/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		form.append("ziel", targetTemp);
		// duration can either be set directly or to default duration
		form.append("duration", targetDuration);

		(async () => {
			try {
				await got.post(url, { body: form });
			} catch (error) {
				this.log.error(error);
			}
		})();
	}

	_setActualTemp(sensorID, actualTemp) {
		this.log.debug(`Setting temperature on Controme mini server for sensor ${sensorID} to ${actualTemp}`);
		const url = "http://" + this.config.url + "/set/json/v1/" + this.config.houseID + "/set/";
		const form = new formData();

		form.append("user", this.config.user);
		form.append("password", this.config.password);
		form.append("sensorid", sensorID);
		form.append("value", actualTemp);

		(async () => {
			try {
				const { body } = await got.post(url, { body: form });
				if (body != "") {
					this.log.error(`Setting ${sensorID} to ${actualTemp} °C returned an unexpected response "${body}"`);
				}
			} catch (error) {
				this.log.error(`Setting ${sensorID} to ${actualTemp} °C returned an error "${error}"`);
			}
		})();
	}

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Controme(options);
} else {
	// otherwise start the instance directly
	new Controme();
}