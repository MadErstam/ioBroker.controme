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

		this.log.debug("Controme URL: " + this.config.url + "; houseID: " + this.config.houseID + "; update interval: " + this.config.interval);

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
				await this.extendForeignObjectAsync(`system.this.${this.namespace}`, { native: { forceReInit: false } });
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
				this.log.silly("Rooms response from Controme mini server: " + JSON.stringify(body));

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
					this.log.silly("Temps response from Controme mini server: " + JSON.stringify(body));

					for (const floor in body) {
						if (Object.prototype.hasOwnProperty.call(body, floor)) {
							for (const room in body[floor].raeume) {
								if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
									this._updateRoom(body[floor].raeume[room]);
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
		this.subscribeStates("*.set_point_temperature");

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

	_updateRoom(room) {
		const promises = [];
		this.log.silly("Updating room " + room.id + " (" + room.name + ")");
		promises.push(this.setStateChangedAsync(room.id + ".actualTemperature", parseFloat(room.temperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".setPointTemperature", parseFloat(room.solltemperatur).round(2), true));
		promises.push(this.setStateChangedAsync(room.id + ".temperatureOffset", parseFloat(room.total_offset).round(2), true));
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
			// The state was changed
			// if change resulted from user action (ack = false), we need to update the setPointTemp on the server
			this.log.info(`State ${id} changed: ${state.val} (ack = ${state.ack})`);
			// extract the roomID from id
			const roomID = id.match(/\.(\d+)\.\w+$/)[1];
			if (state.ack == false && roomID !== null) {
				this._setPointTemp(roomID, state.val);
			}
		} else {
			// The state was deleted
			this.log.debug(`state ${id} deleted`);
		}
	}

	_setPointTemp(roomID, setPointTemp) {
		this.log.info(`Trying to set point temperature on Controme mini server for room ${roomID} to ${setPointTemp}`);
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