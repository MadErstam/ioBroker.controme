'use strict';

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const got = require('got').default;
const { HTTPError } = require('got');
const dayjs = require('dayjs');
const formData = require('form-data');
const { isObject } = require('iobroker.controme/lib/tools');

function roundTo(number, decimals = 0) {
    return Math.round(number * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

class Controme extends utils.Adapter {
    /**
     * Creates a new Controme adapter instance.
     *
     * @param options - Partial adapter options for configuration
     */
    constructor(options = {}) {
        super({
            ...options,
            name: 'controme',
        });
        this.delayPolling = false; // is set when a connection error is detected and prevents polling
        this.delayPollingCounter = 0; // controls the duration, for which polling is delayed
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        // this.on("message", obj => {
        // this.log.debug(`Message received: ${JSON.stringify(obj)}`)
        // });
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize adapter connection state
        await this.setState('info.connection', { val: false, ack: true });

        // Set up poll interval and logging
        const pollInterval = Math.min(
            Number.isInteger(this.config.interval) && this.config.interval > 15 ? this.config.interval : 15,
            3600000,
        ); // pollInterval determines how often the server is polled; we set it to at least once per hour to also keep in line with technical limitations.
        this.temporary_mode_default_duration = Number.isInteger(this.config.temp_duration)
            ? this.config.temp_duration
            : 60;
        this.log.debug(
            `Controme URL: ${this.config.url}; houseID: ${this.config.houseID}; user: ${this.config.user}; update interval: ${pollInterval}; warnOnNull: ${this.config.warnOnNull}`,
        );

        // Re-initialize object structure if needed
        if (this.config.forceReInit) {
            await this._initializeObjectStructure();
        }

        // Start polling and subscribe to states
        this._startPolling(pollInterval);
        this._subscribeToStates();

        // Set connection state to true after setup
        await this.setState('info.connection', { val: true, ack: true });
    }

    // Function to re-initialize the adapter’s object structure if forceReInit is set
    async _initializeObjectStructure() {
        this.log.debug(`Fresh install of adapter or forceReInit selected, initializing object structure.`);
        try {
            const objects = await this.getAdapterObjectsAsync();
            for (const object in objects) {
                if (Object.prototype.hasOwnProperty.call(objects, object)) {
                    this.log.silly(`Purging: ${object}`);
                    if (!object.endsWith('info.connection')) {
                        await this.delForeignObjectAsync(object);
                    }
                }
            }
            this.log.debug(`Purging object structure finished successfully`);
        } catch (error) {
            this.log.error(`Purging object structure failed with ${error}`);
        }

        try {
            await this._createObjects();
            await this.setState('info.connection', { val: true, ack: true });
            this.log.debug(`Creating object structure finished successfully`);
        } catch (error) {
            this.log.error(`Creating object structure failed with ${error}`);
        }

        // Set forceReInit to false to prevent re-initialization on next restart
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { forceReInit: false } });
            this.log.debug(`Initializing object structure finished successfully`);
        } catch (error) {
            this.log.error(`Could not set forceReInit to false: ${error}`);
        }
    }

    // Function to start polling data from the server at the specified interval
    _startPolling(pollInterval) {
        // Poll data from the server immediately
        this._updateIntervalFunction();

        // Set up periodic polling
        this.updateInterval = this.setInterval(this._updateIntervalFunction.bind(this), pollInterval * 1000);
    }

    // Function to subscribe to all relevant states for updates
    _subscribeToStates() {
        this.subscribeStates('*.setpointTemperature');
        this.subscribeStates('*.setpointTemperaturePerm');
        this.subscribeStates('*.temporary_mode_remaining');
        this.subscribeStates('*.sensors.*.actualTemperature');
        this.subscribeStates('*.offsets.*');
    }

    /*
	async onMessage(obj) {
		if (isObject(obj)) {
			this.log.debug(`onMessage called with obj: ${JSON.stringify(obj)}`);
		}
		// if (obj) {
		// 	switch (obj.command) {
		// 		case "command":
		// 			if (obj.callback) {
		// 				this.log.debug(`onMessage called with obj: ${JSON.stringify(obj)}`);
		// 			}
		// 			break;
		// 	}
		// }
	}
	*/

    _updateIntervalFunction() {
        // Poll API, unless server is in error mode
        if (!this.delayPolling) {
            this._pollRoomTemps();
            this._pollOuts();
            if (this.config.gateways != null && typeof this.config.gateways[Symbol.iterator] === 'function') {
                this._pollGateways();
            }
        }
    }

    async _delayPollingFunction() {
        this.delayPolling = true;
        this.delayPollingTimeout = this.setTimeout(
            () => {
                this.delayPolling = false;
            },
            this.delayPollingCounter * 60 * 1000,
        ); // delayPollingCounter is max 10, so timeout is max 600,000 ms = 10 minutes
        this.delayPollingCounter < 10 ? this.delayPollingCounter++ : (this.delayPollingCounter = 10);
        await this.setState('info.connection', { val: false, ack: true });
        this.log.error(
            `Error in polling data from Controme mini server; will retry in ${this.delayPollingCounter} minutes.`,
        );
    }

    async _resetPollingDelay() {
        this.delayPolling = false;
        this.delayPollingCounter = 0;
        await this.setState('info.connection', { val: true, ack: true });
    }

    async _processTempsAPIforCreation(body) {
        this.log.silly(`Temps response from Controme mini server for creation of objects: "${JSON.stringify(body)}"`);
        this.log.debug(`~  Creating room objects (incl. offsets and sensors)`);
        const floorPromises = [];
        for (const floor in body) {
            if (Object.prototype.hasOwnProperty.call(body[floor], 'raeume')) {
                floorPromises.push(this._processRooms(body[floor].raeume));
            }
        }
        await Promise.all(floorPromises);
    }

    // Function to process all rooms on a given floor
    async _processRooms(rooms) {
        const promises = [];
        for (const roomKey in rooms) {
            if (Object.prototype.hasOwnProperty.call(rooms, roomKey)) {
                const room = rooms[roomKey];
                promises.push(
                    Promise.all([
                        this._createObjectsForRoom(room),
                        this._createOffsetsForRoom(room),
                        this._processSensorsForRoom(room),
                    ]),
                );
            }
        }
        await Promise.all(promises);
    }

    // Function to process all sensors for a given room
    async _processSensorsForRoom(room) {
        if (Object.prototype.hasOwnProperty.call(room, 'sensoren')) {
            const sensorPromises = [];
            for (const sensorKey in room.sensoren) {
                if (Object.prototype.hasOwnProperty.call(room.sensoren, sensorKey)) {
                    sensorPromises.push(this._createSensorsForRoom(room.id, room.sensoren[sensorKey]));
                }
            }
            await Promise.all(sensorPromises);
        }
    }

    async _processOutsAPIforCreation(body) {
        // response JSON contains hierarchical information starting with floors and rooms on these floors
        // followed by outputs for each room
        // we need to iterate through the floors and rooms and add the required output structures to the already created rooms

        this.log.silly(`Outs response from Controme mini server for creation of objects: "${JSON.stringify(body)}"`);

        const outputPromises = [];
        for (const floor in body) {
            if (Object.prototype.hasOwnProperty.call(body[floor], 'raeume')) {
                const rooms = body[floor].raeume;
                for (const room in rooms) {
                    if (Object.prototype.hasOwnProperty.call(rooms, room)) {
                        outputPromises.push(this._createOutputsForRoom(rooms[room]));
                    }
                }
            }
        }
        await Promise.all(outputPromises);

        this.log.debug(`~  Creating gateway objects`);
        if (this.config.gateways != null && typeof this.config.gateways[Symbol.iterator] === 'function') {
            const gateways = Array.isArray(this.config.gateways) ? this.config.gateways : [this.config.gateways];
            const gatewayPromises = gateways.map(async gateway => {
                try {
                    await Promise.all(this._createGatewayObjects(gateway));
                    await this._setGatewayObjects(gateway);
                } catch (error) {
                    this.log.error(`Setting newly created gateway states failed with error ${error}`);
                }
            });
            await Promise.all(gatewayPromises);

            if (this.config.gatewayOuts != null && typeof this.config.gatewayOuts[Symbol.iterator] === 'function') {
                const gatewayOuts = Array.isArray(this.config.gatewayOuts)
                    ? this.config.gatewayOuts
                    : [this.config.gatewayOuts];
                this.log.debug(`~  Creating output objects for gateways`);
                const outsPromises = gatewayOuts.map(gatewayOutput => this._createGatewayOutputObjects(gatewayOutput));
                await Promise.all(outsPromises);
            }
        }
    }

    async _createObjects() {
        this.log.debug(`Creating object structure`);

        // Read temp API and create all required objects (rooms and sensors)
        let body;
        try {
            const url = `http://${this.config.url}/get/json/v1/${this.config.houseID}/temps/`;
            const response = await got.get(url);
            body = JSON.parse(response.body);
            await this._processTempsAPIforCreation(body);
        } catch (error) {
            await this._delayPollingFunction();
            this.log.error(
                `Polling temps API from mini server to create data objects for rooms, offsets and sensor failed failed with error "${error}"`,
            );
        }

        this.log.debug(`~  Creating output objects for rooms`);
        try {
            const url = `http://${this.config.url}/get/json/v1/${this.config.houseID}/outs/`;
            const response = await got.get(url);
            body = JSON.parse(response.body);
            await this._processOutsAPIforCreation(body);
        } catch (error) {
            await this._delayPollingFunction();
            this.log.error(
                `Polling outs API from mini server to create data objects for outputs failed failed with error "${error}"`,
            );
        }

        // the connection indicator is updated when the connection was successful
    }

    _createObjectsForRoom(room) {
        const promises = [];
        this.log.silly(`Creating objects for room ${room.id} (${room.name}): Basic object structure`);
        promises.push(
            this.setObjectNotExistsAsync(room.id.toString(), {
                type: 'device',
                common: { name: room.name },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.actualTemperature`, {
                type: 'state',
                common: {
                    name: `${room.name} actual temperature`,
                    type: 'number',
                    unit: '°C',
                    role: 'value.temperature',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.setpointTemperature`, {
                type: 'state',
                common: {
                    name: `${room.name} setpoint temperature`,
                    type: 'number',
                    unit: '°C',
                    role: 'level.temperature',
                    read: true,
                    write: true,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.temperatureOffset`, {
                type: 'state',
                common: {
                    name: `${room.name} temperature offset`,
                    type: 'number',
                    unit: '°C',
                    role: 'value',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.setpointTemperaturePerm`, {
                type: 'state',
                common: {
                    name: `${room.name} permanent setpoint temperature`,
                    type: 'number',
                    unit: '°C',
                    role: 'level.temperature',
                    read: true,
                    write: true,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.is_temporary_mode`, {
                type: 'state',
                common: {
                    name: `${room.name} is in temporary mode`,
                    type: 'boolean',
                    unit: '',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.temporary_mode_remaining`, {
                type: 'state',
                common: {
                    name: `${room.name}  temporary mode remaining time `,
                    type: 'number',
                    unit: 's',
                    role: 'level.timer',
                    read: true,
                    write: true,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.temporary_mode_end`, {
                type: 'state',
                common: {
                    name: `${room.name}  temporary mode end time `,
                    type: 'number',
                    unit: '',
                    role: 'value.datetime',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.humidity`, {
                type: 'state',
                common: {
                    name: `${room.name} humidity`,
                    type: 'number',
                    unit: '%',
                    role: 'value.humidity',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.mode`, {
                type: 'state',
                common: {
                    name: `${room.name} operating mode`,
                    type: 'string',
                    unit: '',
                    role: 'state',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.sensors`, {
                type: 'channel',
                common: { name: `${room.name} sensors` },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.offsets`, {
                type: 'channel',
                common: { name: `${room.name} offsets` },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${room.id}.outputs`, {
                type: 'channel',
                common: { name: `${room.name} outputs` },
                native: {},
            }),
        );
        return Promise.all(promises);
    }

    _createGatewayObjects(gw) {
        const promises = [];
        this.log.silly(`Creating gateway objects for ${gw.gatewayMAC}`);
        promises.push(
            this.setObjectNotExistsAsync(gw.gatewayMAC, {
                type: 'device',
                common: { name: gw.gatewayName },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${gw.gatewayMAC}.gatewayType`, {
                type: 'state',
                common: {
                    name: `${gw.gatewayName} type`,
                    type: 'string',
                    unit: '',
                    role: 'state',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${gw.gatewayMAC}.isUniversal`, {
                type: 'state',
                common: {
                    name: `${gw.gatewayName} isUniversal`,
                    type: 'boolean',
                    unit: '',
                    role: 'state',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${gw.gatewayMAC}.outputs`, {
                type: 'channel',
                common: { name: `${gw.gatewayName} outputs` },
                native: {},
            }),
        );
        return promises;
    }

    _setGatewayObjects(gw) {
        const promises = [];
        this.log.silly(`Setting gateway objects for ${gw.gatewayMAC}`);
        promises.push(this.setStateAsync(`${gw.gatewayMAC}.gatewayType`, gw.gatewayType, true));
        promises.push(
            this.setStateAsync(
                `${gw.gatewayMAC}.isUniversal`,
                gw.gatewayType == 'gwUniMini' || gw.gatewayType == 'gwUniPro',
                true,
            ),
        );
        return Promise.all(promises);
    }

    _createGatewayOutputObjects(gwo) {
        const promises = [];
        this.log.silly(`Creating gateway output object for ${gwo.gatewayOutsMAC} Output ${gwo.gatewayOutsID}`);
        promises.push(
            this.setObjectNotExistsAsync(`${gwo.gatewayOutsMAC}.outputs.${gwo.gatewayOutsID}`, {
                type: 'state',
                common: {
                    name: gwo.gatewayOutsName,
                    type: 'number',
                    unit: '',
                    min: 0,
                    max: 1,
                    role: 'state',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        return Promise.all(promises);
    }

    isEmpty(object) {
        for (const i in object) {
            return false;
        }
        return true;
    }

    objSafeName(name) {
        // Some characters are not allowed to be used as part of an object id. Replace chars from constant adapter.FORBIDDEN_CHARS.
        return (name || '').replace(this.FORBIDDEN_CHARS, '_');
    }

    _createOffsetsForRoom(room) {
        const promises = [];
        for (const offset in room.offsets) {
            if (Object.prototype.hasOwnProperty.call(room.offsets, offset)) {
                if (typeof room.offsets[offset] === 'object') {
                    if (!this.isEmpty(room.offsets[offset])) {
                        // if offset object is not empty, we create the relevant object structure
                        promises.push(
                            this.setObjectNotExistsAsync(`${room.id}.offsets.${offset}`, {
                                type: 'channel',
                                common: { name: `${room.name} offset ${offset}` },
                                native: {},
                            }),
                        );
                        for (const offset_item in room.offsets[offset]) {
                            // offset_item might contain unsafe characters
                            if (Object.prototype.hasOwnProperty.call(room.offsets[offset], offset_item)) {
                                this.log.silly(
                                    `Creating offset objects for room ${room.id}: Offset ${offset}.${this.objSafeName(offset_item)}`,
                                );
                                // all states for offset channel "api" should be read-write, else read-only
                                promises.push(
                                    this.setObjectNotExistsAsync(
                                        `${room.id}.offsets.${this.objSafeName(offset)}.${this.objSafeName(
                                            offset_item,
                                        )}`,
                                        {
                                            type: 'state',
                                            common: {
                                                name: `${room.name} offset ${offset} ${offset_item}`,
                                                type: 'number',
                                                unit: '°C',
                                                role: offset == 'api' ? 'level' : 'value',
                                                read: true,
                                                write: offset == 'api',
                                            },
                                            native: {},
                                        },
                                    ),
                                );
                            }
                        }
                    } else if (offset == 'api') {
                        // for an empty offset object "api", we create a dedicated structure, since it can be used to set api offsets, so needs to be read/write
                        // this.log.silly(`Creating object structure for offset object ${offset}`);
                        this.log.silly(`Creating offset objects for room ${room.id}: Offset ${offset}.api`);
                        promises.push(
                            this.setObjectNotExistsAsync(`${room.id}.offsets.api`, {
                                type: 'channel',
                                common: { name: `${room.name} offset api` },
                                native: {},
                            }),
                        );
                        promises.push(
                            this.setObjectNotExistsAsync(`${room.id}.offsets.api.raum`, {
                                type: 'state',
                                common: {
                                    name: `${room.name} offset api raum`,
                                    type: 'number',
                                    unit: '°C',
                                    role: 'level',
                                    read: true,
                                    write: true,
                                },
                                native: {},
                            }),
                        );
                    }
                }
            }
        }
        // Some servers do not include an api module, so the read/write states are not created. Check if "api" exists, if not, create it
        if (typeof room.offsets['api'] === 'undefined') {
            // for the offset object api, we create a dedicated structure, since it can be used to set api offsets, so needs to be read/write
            // this.log.silly(`Creating object structure for offset object ${offset}`);
            this.log.info(`Creating objects for room ${room.id}: Offset api.api`);
            promises.push(
                this.setObjectNotExistsAsync(`${room.id}.offsets.api`, {
                    type: 'channel',
                    common: { name: `${room.name} offset api` },
                    native: {},
                }),
            );
            promises.push(
                this.setObjectNotExistsAsync(`${room.id}.offsets.api.raum`, {
                    type: 'state',
                    common: {
                        name: `${room.name} offset api raum`,
                        type: 'number',
                        unit: '°C',
                        role: 'level',
                        read: true,
                        write: true,
                    },
                    native: {},
                }),
            );
        }
        return Promise.all(promises);
    }

    _createSensorsForRoom(roomID, sensor) {
        const promises = [];
        this.log.silly(
            `Creating sensor objects for room ${roomID}: Sensor ${this.objSafeName(sensor.name)} (${sensor.beschreibung})`,
        );
        promises.push(
            this.setObjectNotExistsAsync(`${roomID}.sensors.${this.objSafeName(sensor.name)}`, {
                type: 'device',
                common: {
                    name: `${sensor.beschreibung}`,
                },
                native: {},
            }),
        );
        promises.push(
            this.setObjectNotExistsAsync(`${roomID}.sensors.${this.objSafeName(sensor.name)}.isRoomTemperatureSensor`, {
                type: 'state',
                common: {
                    name: `${sensor.beschreibung} is room temperature sensor`,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            }),
        );
        // sensor.wert can be either single value or object
        if (isObject(sensor.wert)) {
            for (const [key, value] of Object.entries(sensor.wert)) {
                this.log.silly(`Creating individual sensor value objects for room ${roomID}: Output ${key}:${value}`);
                // currently known object values are Helligkeit (brightness), Relative Luftfeuchtigkeit (humidity), Bewegung (motion), Temperatur (temperatur)
                switch (key) {
                    case 'Helligkeit':
                        promises.push(
                            this.setObjectNotExistsAsync(
                                `${roomID}.sensors.${this.objSafeName(sensor.name)}.brightness`,
                                {
                                    type: 'state',
                                    common: {
                                        name: `${sensor.beschreibung} brightness`,
                                        type: 'number',
                                        unit: 'lux',
                                        role: 'value.brightness',
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                },
                            ),
                        );
                        break;
                    case 'Relative Luftfeuchte':
                        promises.push(
                            this.setObjectNotExistsAsync(
                                `${roomID}.sensors.${this.objSafeName(sensor.name)}.humidity`,
                                {
                                    type: 'state',
                                    common: {
                                        name: `${sensor.beschreibung} humidity`,
                                        type: 'number',
                                        unit: '%',
                                        role: 'value.humidity',
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                },
                            ),
                        );
                        break;
                    case 'Bewegung':
                        promises.push(
                            this.setObjectNotExistsAsync(`${roomID}.sensors.${this.objSafeName(sensor.name)}.motion`, {
                                type: 'state',
                                common: {
                                    name: `${sensor.beschreibung} motion`,
                                    type: 'boolean',
                                    role: 'sensor.motion',
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            }),
                        );
                        break;
                    case 'Temperatur':
                        promises.push(
                            this.setObjectNotExistsAsync(
                                `${roomID}.sensors.${this.objSafeName(sensor.name)}.actualTemperature`,
                                {
                                    type: 'state',
                                    common: {
                                        name: `${sensor.beschreibung} actual temperature`,
                                        type: 'number',
                                        unit: '°C',
                                        role: 'level.temperature',
                                        read: true,
                                        write: true,
                                    },
                                    native: {},
                                },
                            ),
                        );
                        break;
                    default:
                        promises.push(
                            this.setObjectNotExistsAsync(`${roomID}.sensors.${this.objSafeName(sensor.name)}.${key}`, {
                                type: 'state',
                                common: {
                                    name: `${sensor.beschreibung} ${key}`,
                                    type: 'number',
                                    unit: '',
                                    role: 'level',
                                    read: true,
                                    write: true,
                                },
                                native: {},
                            }),
                        );
                }
            }
        } else {
            promises.push(
                this.setObjectNotExistsAsync(`${roomID}.sensors.${this.objSafeName(sensor.name)}.actualTemperature`, {
                    type: 'state',
                    common: {
                        name: `${sensor.beschreibung} actual temperature`,
                        type: 'number',
                        unit: '°C',
                        role: 'level.temperature',
                        read: true,
                        write: true,
                    },
                    native: {},
                }),
            );
        }
        return Promise.all(promises);
    }

    _createOutputsForRoom(room) {
        const promises = [];
        if (Object.prototype.hasOwnProperty.call(room, 'ausgang')) {
            const outputs = room.ausgang;
            for (const [key, value] of Object.entries(outputs)) {
                this.log.silly(`Creating output objects for room ${room.id}: Output ${key}:${value}`);
                promises.push(
                    this.setObjectNotExistsAsync(`${room.id}.outputs.${key}`, {
                        type: 'state',
                        common: {
                            name: `${room.name} outputs ${key}`,
                            type: 'number',
                            role: 'value',
                            read: true,
                            write: false,
                        },
                        native: {},
                    }),
                );
            }
        }
        return Promise.all(promises);
    }

    async _updateOffsetStatesForRoom(room) {
        // Controme deletes offsets that have been set via the api; we need to check which offsets still exist and delete those that do no longer exist
        // Get all offset states (states in channel offset) of the respective room and check if these are still included in the temps API response
        try {
            // Wrapper für getStatesOf, damit wir ein Promise zurückbekommen
            const obj = await new Promise((resolve, reject) => {
                this.getStatesOf(`${this.namespace}.${room.id}`, 'offsets', (err, states) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(states);
                    }
                });
            });
            this.log.silly(`_updateOffsetStatesForRoom: getStatesOf returned obj: ${JSON.stringify(obj)}`);
            const promises = [];
            for (const offset in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, offset)) {
                    const id = obj[offset]._id;
                    const roomIdMatch = id.match(/^controme\.\d\.(\d+)/);
                    const offsetChannelMatch = id.match(/offsets\.([^.]+)\./);
                    const offsetStateMatch = id.match(/offsets\.[^.]+\.([^.]+)/);

                    if (!roomIdMatch || !offsetChannelMatch || !offsetStateMatch) {
                        this.log.warn(`Skipping offset with invalid format: ${id}`);
                        continue;
                    }

                    const roomID = roomIdMatch[1];
                    const offsetChannel = offsetChannelMatch[1];
                    const offsetState = offsetStateMatch[1];

                    // offsetChannels are created by API, FPS, KI, and several other modules
                    if (offsetChannel in room.offsets) {
                        this.log.silly(`Offset channel ${roomID}.${offsetChannel} still exists in API response`);
                        if (offsetState in room.offsets[offsetChannel]) {
                            this.log.silly(
                                `Offset state ${roomID}.${offsetChannel}.${offsetState} still exists in API response`,
                            );
                        } else {
                            // the previously existing offsetState does not exist anymore
                            if (offsetChannel === 'api') {
                                // if the previously existing offsetState was created in the api channel, we leave it, but set it to 0°C
                                this.log.silly(
                                    `Offset state ${offsetState} no longer exists in API response, but is in API channel, so setting it to 0°C`,
                                );
                                promises.push(this.setStateAsync(obj[offset]._id, 0, true));
                            } else {
                                // if the previously existing offsetState was created in any other channel than api, we delete it
                                this.log.debug(
                                    `Deleting offset state ${obj[offset]._id}, since it does not exist in API response`,
                                );
                                promises.push(this.delObjectAsync(obj[offset]._id));
                            }
                        }
                    } else {
                        // if the previously existing offsetChannel does no longer exist in API response, we delete it
                        if (offsetChannel !== 'api') {
                            this.log.debug(
                                `Deleting offset channel ${this.namespace}.${roomID}.${offsetChannel}, since it does not appear in API response`,
                            );
                            promises.push(this.delObjectAsync(`${this.namespace}.${roomID}.${offsetChannel}`));
                        }
                    }
                }
            }
            await Promise.all(promises);
        } catch (error) {
            this.log.error(`Error updating offset states for room ${room.id}: ${error}`);
        }
    }

    async _processTempsAPIforUpdate(body) {
        this.log.silly(`Temps response from Controme mini server: "${JSON.stringify(body)}"`);
        const roomPromises = [];
        for (const floor in body) {
            if (Object.prototype.hasOwnProperty.call(body, floor)) {
                for (const room in body[floor].raeume) {
                    if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
                        const roomObj = body[floor].raeume[room];
                        this.log.silly(`Processing temps API for room ${body[floor].raeume[room].id}`);
                        // Alle asynchronen Operationen für den Raum in einem Promise zusammenfassen
                        roomPromises.push(
                            (async () => {
                                await this._updateRoom(roomObj);
                                await this._updateOffsetStatesForRoom(roomObj);
                                await this._updateOffsetsForRoom(roomObj);
                                await this._updateSensorsForRoom(roomObj);
                                this.log.silly(`Finished processing temps API for room ${roomObj.id}`);
                            })(),
                        );
                    }
                }
            }
        }
        await Promise.all(roomPromises);
    }

    async _pollRoomTemps() {
        // Poll data from temps API
        this.log.debug('Polling temps API from mini server');
        let body;

        try {
            const url = `http://${this.config.url}/get/json/v1/${this.config.houseID}/temps/`;
            const response = await got.get(url);
            body = JSON.parse(response.body);
            await this._processTempsAPIforUpdate(body);
            await this._resetPollingDelay();
        } catch (error) {
            await this._delayPollingFunction();
            this.log.error(`Polling temperature data from Controme mini server finished with error "${error}"`);
        }
    }

    async _processOutsAPIforUpdate(body) {
        this.log.silly(`Outs response from Controme mini server: "${JSON.stringify(body)}"`);
        const promises = [];
        for (const floor in body) {
            if (Object.prototype.hasOwnProperty.call(body[floor], 'raeume')) {
                for (const room in body[floor].raeume) {
                    if (Object.prototype.hasOwnProperty.call(body[floor].raeume, room)) {
                        const roomObj = body[floor].raeume[room];
                        this.log.silly(`Processing outs API for room ${roomObj.id}`);
                        promises.push(this._updateOutputsForRoom(roomObj));
                        this.log.silly(`Finished processing outs API for room ${roomObj.id}`);
                    }
                }
            }
        }
        await Promise.all(promises);
    }

    async _pollOuts() {
        // Poll data from outs API
        this.log.debug('Polling outs API  from mini server');
        let body;
        try {
            const url = `http://${this.config.url}/get/json/v1/${this.config.houseID}/outs/`;
            const response = await got.get(url);
            body = JSON.parse(response.body);
            await this._processOutsAPIforUpdate(body);
            await this._resetPollingDelay();
        } catch (error) {
            // when an error is received, the connection indicator is updated accordingly
            await this._delayPollingFunction();
            this.log.error(`Polling outputs data from Controme mini server finished with error "${error}"`);
        }
    }

    async _pollGateways() {
        const gateways = Array.isArray(this.config.gateways) ? this.config.gateways : [this.config.gateways];
        for (const gateway of gateways) {
            try {
                if (gateway.gatewayType === 'gwUniPro') {
                    await this._pollIndividualGatewayOutputs(gateway);
                } else {
                    await this._pollAllGatewayOutputs(gateway);
                }
                await this._resetPollingDelay();
            } catch (error) {
                await this._delayPollingFunction();
                this.log.error(`Error polling gateway ${gateway.gatewayMAC} from mini server: ${error}`);
            }
        }
    }

    // Polls each output of a "gwUniPro" gateway individually
    async _pollIndividualGatewayOutputs(gateway) {
        this.log.debug(`Polling individual outputs for gateway ${gateway.gatewayName} from mini server`);
        const outputs = await this.getStatesOfAsync(`${this.namespace}.${gateway.gatewayMAC}`, 'outputs');

        for (const output of outputs) {
            const outputID = this._extractOutputID(output._id);
            const url = `http://${this.config.url}/get/${gateway.gatewayMAC}/${outputID}/`;

            try {
                const response = await got.get(url);
                await this._setGatewayOutputState(gateway.gatewayMAC, output._id, response.body);
            } catch (error) {
                this.log.error(`Error polling data for output ${gateway.gatewayMAC}:${outputID}: ${error}`);
            }
        }
    }

    // Polls all outputs of a non-"gwUniPro" gateway in a single request
    async _pollAllGatewayOutputs(gateway) {
        this.log.debug(`Polling all outputs for gateway ${gateway.gatewayName} from mini server`);
        const url = `http://${this.config.url}/get/${gateway.gatewayMAC}/all/`;
        const outputs = await this.getStatesOfAsync(`${this.namespace}.${gateway.gatewayMAC}`, 'outputs');

        try {
            const response = await got.get(url);
            const outputValues = this._parseGatewayOutputValues(response.body);

            for (const [, output] of outputs.entries()) {
                const outputID = this._extractOutputID(output._id);
                const value = parseFloat(outputValues[parseInt(outputID) - 1]);
                await this.setState(output._id, value, true);
                this.log.silly(`Setting gateway output ${gateway.gatewayMAC}:${outputID} to ${value}`);
            }
        } catch (error) {
            this.log.error(`Error polling outputs for gateway ${gateway.gatewayMAC}: ${error}`);
        }
    }

    // Parses the gateway output values from the API response string
    _parseGatewayOutputValues(responseBody) {
        if (typeof responseBody === 'string') {
            return responseBody.substring(1, responseBody.length - 1).split(';');
        }
        return [];
    }

    // Sets the state for a specific gateway output
    async _setGatewayOutputState(gatewayMAC, outputId, body) {
        if (typeof body === 'string') {
            const value = parseInt(body.substring(1, body.length - 1));
            await this.setState(outputId, value, true); // Use await with setState
            this.log.silly(`Setting gateway output ${gatewayMAC}:${this._extractOutputID(outputId)} to ${value}`);
        }
    }
    // Extracts the output ID from a full state ID
    _extractOutputID(fullId) {
        return fullId.substring(fullId.lastIndexOf('.') + 1);
    }

    _updateRoom(room) {
        const promises = [];
        this.log.silly(
            `Updating room ${room.id} (${room.name}): Actual temperature ${roundTo(parseFloat(room.temperatur), 2)} °C, setpoint temperature ${roundTo(parseFloat(room.solltemperatur), 2)} °C, temperature offset ${roundTo(parseFloat(room.total_offset), 2)} °C`,
        );

        // Update actual temperature
        const temp = parseFloat(room.temperatur);
        if (isFinite(temp)) {
            const actualTemp = roundTo(temp, 2);
            promises.push(this.setStateChangedAsync(`${room.id}.actualTemperature`, actualTemp, true));
        } else {
            this.log.warn(`Room ${room.id} (${room.name}): Invalid actual temperature value: ${room.temperatur}`);
            promises.push(this.setStateChangedAsync(`${room.id}.actualTemperature`, null, true));
        }

        // Update setpoint temperature
        const setpoint = parseFloat(room.solltemperatur);
        if (isFinite(setpoint)) {
            const setpointTemp = roundTo(setpoint, 2);
            promises.push(this.setStateChangedAsync(`${room.id}.setpointTemperature`, setpointTemp, true));
        } else {
            this.log.warn(`Room ${room.id} (${room.name}): Invalid setpoint temperature value: ${room.solltemperatur}`);
            promises.push(this.setStateChangedAsync(`${room.id}.setpointTemperature`, null, true));
        }

        // Update temperature offset
        const offset = parseFloat(room.total_offset);
        if (isFinite(offset)) {
            const tempOffset = roundTo(offset, 2);
            promises.push(this.setStateChangedAsync(`${room.id}.temperatureOffset`, tempOffset, true));
        } else {
            this.log.warn(`Room ${room.id} (${room.name}): Invalid temperature offset value: ${room.total_offset}`);
            promises.push(this.setStateChangedAsync(`${room.id}.temperatureOffset`, null, true));
        }

        // Update permanent setpoint temperature
        const permSetpoint = parseFloat(room.perm_solltemperatur);
        if (isFinite(permSetpoint)) {
            const permTemp = roundTo(permSetpoint, 2);
            promises.push(this.setStateChangedAsync(`${room.id}.setpointTemperaturePerm`, permTemp, true));
        } else {
            this.log.warn(
                `Room ${room.id} (${room.name}): Invalid permanent setpoint temperature value: ${room.perm_solltemperatur}`,
            );
            promises.push(this.setStateChangedAsync(`${room.id}.setpointTemperaturePerm`, null, true));
        }

        // Directly update is_temporary_mode
        promises.push(this.setStateChangedAsync(`${room.id}.is_temporary_mode`, room.is_temporary_mode, true));

        // Update remaining time for temporary_mode
        const remaining = parseInt(room.remaining_time);
        if (!isNaN(remaining)) {
            promises.push(this.setStateChangedAsync(`${room.id}.temporary_mode_remaining`, remaining, true));
        } else {
            if (room.is_temporary_mode) {
                this.log.warn(
                    `Room ${room.id} (${room.name}): Invalid remaining time for temporary mode: ${room.remaining_time}`,
                );
            }
            promises.push(this.setStateChangedAsync(`${room.id}.temporary_mode_remaining`, null, true));
        }

        // Update end time for temporary_mode
        if (room.mode_end_datetime == null) {
            promises.push(this.setStateChangedAsync(`${room.id}.temporary_mode_end`, null, true));
        } else {
            const unixTime = dayjs(room.mode_end_datetime).unix();
            if (isFinite(unixTime)) {
                promises.push(this.setStateChangedAsync(`${room.id}.temporary_mode_end`, unixTime, true));
            } else {
                if (room.is_temporary_mode) {
                    this.log.warn(
                        `Room ${room.id} (${room.name}): Invalid end time for temporary mode: ${room.mode_end_datetime}`,
                    );
                }
                promises.push(this.setStateChangedAsync(`${room.id}.temporary_mode_end`, null, true));
            }
        }

        // Update humidity
        const humidity = parseInt(room.luftfeuchte);
        if (!isNaN(humidity)) {
            promises.push(this.setStateChangedAsync(`${room.id}.humidity`, humidity, true));
        } else {
            this.log.debug(`Room ${room.id} (${room.name}): Invalid humidity value: ${room.luftfeuchte}`);
            promises.push(this.setStateChangedAsync(`${room.id}.humidity`, null, true));
        }

        // Directly update opting mode
        promises.push(this.setStateChangedAsync(`${room.id}.mode`, room.betriebsart, true));

        return Promise.all(promises);
    }

    hasJsonStructure(str) {
        if (typeof str !== 'string') {
            return false;
        }
        try {
            const result = JSON.parse(str);
            const type = Object.prototype.toString.call(result);
            return type === '[object Object]' || type === '[object Array]';
        } catch {
            return false;
        }
    }

    async _updateOffsetsForRoom(room) {
        const promises = [];

        for (const offsetKey in room.offsets) {
            if (!Object.prototype.hasOwnProperty.call(room.offsets, offsetKey)) {
                continue;
            }

            const offsetObject = room.offsets[offsetKey];

            if (this._isNonEmptyObject(offsetObject)) {
                promises.push(...this._updateOffsetItems(room, offsetKey, offsetObject));
            }
        }

        return Promise.all(promises);
    }

    _isNonEmptyObject(object) {
        return typeof object === 'object' && !this.isEmpty(object);
    }

    _updateOffsetItems(room, offsetKey, offsetObject) {
        const promises = [];

        // Iterate over each key/value pair in the offset object
        for (const [offsetItemKey, rawValue] of Object.entries(offsetObject)) {
            // Parse the value into a float
            const parsedValue = parseFloat(rawValue);

            // Check if the parsed value is a valid finite number
            if (!isFinite(parsedValue)) {
                this.log.warn(
                    `Room ${room.id}: Offset ${offsetKey}.${offsetItemKey} has an invalid numeric value (${rawValue}). Setting value to null.`,
                );
                promises.push(
                    this.setStateChangedAsync(
                        `${room.id}.offsets.${this.objSafeName(offsetKey)}.${this.objSafeName(offsetItemKey)}`,
                        null,
                        true,
                    ),
                );
            } else {
                const value = roundTo(parsedValue, 2);
                this.log.silly(`Updating room ${room.id}: Offset ${offsetKey}.${offsetItemKey} to ${value} °C`);
                promises.push(
                    this.setStateChangedAsync(
                        `${room.id}.offsets.${this.objSafeName(offsetKey)}.${this.objSafeName(offsetItemKey)}`,
                        value,
                        true,
                    ),
                );
            }
        }
        return promises;
    }

    async _updateSensorsForRoom(room) {
        // Check if sensors are defined for the room
        if (!room.sensoren || typeof room.sensoren !== 'object') {
            this.log.warn(`Room ${room.id}: No sensors defined in API response.`);
            return [];
        }
        const promises = [];
        // Iterate over each sensor in the room
        for (const [sensorKey, sensor] of Object.entries(room.sensoren)) {
            // If the sensor object is missing, log a warning and skip it
            if (!sensor) {
                this.log.warn(`Room ${room.id}: Sensor with key ${sensorKey} is undefined.`);
                continue;
            }
            // Construct a safe path for the sensor using a helper function to sanitize the sensor name
            const sensorPath = `${room.id}.sensors.${this.objSafeName(sensor.name)}`;
            // Log the current room temperature sensor status for debugging purposes
            this.log.silly(`${sensorPath}.isRoomTemperatureSensor: ${sensor.raumtemperatursensor}`);
            // Update the 'isRoomTemperatureSensor' state
            promises.push(
                this.setStateChangedAsync(`${sensorPath}.isRoomTemperatureSensor`, sensor.raumtemperatursensor, true),
            );
            // Delegate updating the sensor's value(s) to a helper function that handles different value types
            promises.push(...this._updateSensorValue(room, sensor, sensorPath));
        }
        return Promise.all(promises);
    }

    _updateSensorValue(room, sensor, sensorPath) {
        const promises = [];
        const sensorValue = sensor.wert;

        if (sensorValue && typeof sensorValue === 'object') {
            promises.push(...this._handleObjectSensorValue(room, sensor, sensorPath, sensorValue));
        } else if (typeof sensorValue === 'number') {
            promises.push(...this._handleNumericSensorValue(room, sensor, sensorPath, sensorValue));
        } else if (this.config.warnOnNull) {
            this.log.warn(
                `Room ${room.id}: Temperature value for sensor ${this.objSafeName(sensor.name)} is null or empty`,
            );
        }

        return promises;
    }

    _handleObjectSensorValue(room, sensor, sensorPath, sensorValue) {
        const promises = [];
        const temperature = sensorValue.Temperatur;

        if (temperature !== null && temperature !== undefined && !isNaN(parseFloat(temperature))) {
            this.log.silly(
                `Updating ${sensorPath}: ${this.objSafeName(sensor.name)} (${sensor.beschreibung}) to ${temperature} °C`,
            );
            promises.push(
                this.setStateChangedAsync(`${sensorPath}.actualTemperature`, roundTo(parseFloat(temperature), 2), true),
            );
        } else if (this.config.warnOnNull) {
            this.log.warn(
                `Room ${room.id}: Temperature value for sensor ${this.objSafeName(sensor.name)} is undefined, null or not a number`,
            );
        }

        return promises;
    }

    _handleNumericSensorValue(room, sensor, sensorPath, sensorValue) {
        const promises = [];

        if (sensorValue !== null && sensorValue !== undefined && !isNaN(sensorValue)) {
            this.log.silly(
                `Updating ${sensorPath}: ${this.objSafeName(sensor.name)} (${sensor.beschreibung}) to ${roundTo(sensorValue, 2)} °C`,
            );
            promises.push(this.setStateChangedAsync(`${sensorPath}.actualTemperature`, roundTo(sensorValue, 2), true));
        } else {
            this.log.warn(
                `Room ${room.id}: Value for sensor ${this.objSafeName(sensor.name)} is undefined, null or not a number`,
            );
        }

        return promises;
    }

    _updateOutputsForRoom(room) {
        const promises = [];
        if (Object.prototype.hasOwnProperty.call(room, 'ausgang')) {
            const outputs = room.ausgang;
            for (const [key, value] of Object.entries(outputs)) {
                this.log.silly(`Updating room ${room.id}: Output: ${key} to ${value}`);
                promises.push(this.setStateChangedAsync(`${room.id}.outputs.${key}`, parseFloat(value), true));
            }
        }
        return Promise.all(promises);
    }

    /**
     * Is called when adapter shuts down
     *
     * @param callback -- callback function; callback has to be called under any circumstances!
     */
    onUnload(callback) {
        try {
            this.log.debug('Stopping update interval.');
            // Here you must clear all timeouts or intervals that may still be active
            if (this.updateInterval != null) {
                this.clearInterval(this.updateInterval);
            }
            if (typeof this.delayPollingTimeout === 'number') {
                this.clearTimeout(this.delayPollingTimeout);
            }
            callback();
        } catch {
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
     *
     * @param id -- id of the subscribed state
     * @param state -- state object of the subscribed state
     */
    async onStateChange(id, state) {
        if (!state) {
            // Log state deletions directly
            this.log.debug(`State ${id} deleted`);
            return;
        }

        // Only react to changes initiated by the user, where ack == false
        if (!state.ack) {
            const [, roomID] = id.match(/^controme\.\d\.(\d+)/) || [];
            if (!roomID || state.val === null) {
                this.log.error(`Change of subscribed state ${id} to ${state.val} °C (ack = ${state.ack}) failed`);
                return;
            }

            // Switch based on the specific state type
            switch (true) {
                case id.endsWith('.setpointTemperaturePerm'): {
                    await this.handleSetpointTemperaturePerm(roomID, state.val);
                    break;
                }
                case id.endsWith('.setpointTemperature'): {
                    await this.handleSetpointTemperature(roomID, state.val);
                    break;
                }
                case id.endsWith('.temporary_mode_remaining'): {
                    await this.handleTemporaryModeRemaining(roomID, state.val);
                    break;
                }
                case id.endsWith('.actualTemperature'): {
                    const sensorID = this.extractSensorID(id);
                    if (sensorID) {
                        await this.handleActualTemperature(roomID, sensorID, state.val);
                    } else {
                        this.log.error(`Failed to extract sensor ID from ${id}`);
                    }
                    break;
                }
                case id.includes('.offsets.'): {
                    const apiID = this.extractApiID(id);
                    if (apiID) {
                        await this.handleOffsetTemperature(roomID, apiID, state.val);
                    } else {
                        this.log.error(`Failed to extract API ID from ${id}`);
                    }
                    break;
                }
                default: {
                    this.log.error(
                        `Unhandled change of subscribed state: ${id} changed to ${state.val} (ack = ${state.ack})`,
                    );
                }
            }
        }
    }

    // Utility method to extract room ID
    extractRoomID(id) {
        const match = id.match(/^controme\.\d\.(\d+)/);
        return match ? match[1] : null;
    }

    // Utility method to extract sensor ID
    extractSensorID(id) {
        const match = id.match(/\.sensors\.([0-9a-f_:]+)\./);
        return match ? match[1] : null;
    }

    // Utility method to extract API ID for offsets
    extractApiID(id) {
        const match = id.match(/offsets\.[^.]+\.(.+)/);
        return match ? match[1] : null;
    }

    // Handler for setpointTemperaturePerm
    async handleSetpointTemperaturePerm(roomID, value) {
        this.log.silly(`Room ${roomID}: Calling _setSetpointTempPerm(${roomID}, ${value})`);
        await this._setSetpointTempPerm(roomID, value);
    }

    // Handler for setpointTemperature
    async handleSetpointTemperature(roomID, value) {
        this.log.silly(
            `Room ${roomID}: Calling _setSetpointTemp(${roomID}, ${value}, ${this.temporary_mode_default_duration}) with updated setpoint temperature and default duration defined in config`,
        );
        await this._setSetpointTemp(roomID, value, this.temporary_mode_default_duration);
    }

    // Async handler for temporary_mode_remaining
    async handleTemporaryModeRemaining(roomID, remainingDuration) {
        const setpointTempID = `controme.0.${roomID}.setpointTemperature`;
        const remainingDurationInMinutes = Math.round(remainingDuration / 60);
        try {
            const setpointTempState = await this.getStateAsync(setpointTempID);
            if (setpointTempState && setpointTempState.val !== null) {
                this.log.debug(
                    `Room ${roomID}: Calling _setSetpointTemp(${roomID}, ${setpointTempState.val}, ${remainingDurationInMinutes}) with current setpoint temperature and updated duration `,
                );
                await this._setSetpointTemp(roomID, setpointTempState.val, remainingDurationInMinutes);
            } else {
                this.log.warn(`Failed to retrieve setpointTemperature state for ${setpointTempID}`);
            }
        } catch (error) {
            this.log.error(`Error retrieving state for ${setpointTempID}: ${error}`);
        }
    }

    // Handler for actualTemperature
    async handleActualTemperature(roomID, sensorID, value) {
        this.log.silly(`Room ${roomID}: Calling setActualTemp(${roomID}, ${sensorID}, ${value})`);
        await this._setActualTemp(roomID, sensorID, value);
    }

    // Handler for offsets
    async handleOffsetTemperature(roomID, apiID, value) {
        this.log.silly(`Room ${roomID}: Calling setOffsetTemp(${roomID}, ${apiID}, ${value})`);
        await this._setOffsetTemp(roomID, apiID, value);
    }

    async _setSetpointTempPerm(roomID, setpointTemp) {
        const url = `http://${this.config.url}/set/json/v1/${this.config.houseID}/soll/${roomID}/`;
        const form = new formData();

        form.append('user', this.config.user);
        form.append('password', this.config.password);
        if (typeof setpointTemp === 'number' && isFinite(setpointTemp)) {
            setpointTemp = Math.trunc((Math.round(setpointTemp * 8) / 8) * 100) / 100;
            form.append('soll', setpointTemp);

            this.log.debug(`_setSetpointTemp: url = "${url}" -- form = "${JSON.stringify(form)}"`);
            try {
                await got.post(url, { body: form });
                this.log.debug(`Room ${roomID}: Setting setpoint temperature to ${setpointTemp} °C`);
            } catch (error) {
                await this.setState('info.connection', false, true);
                this.log.error(`Room ${roomID}: Setting setpoint temperature returned an error "${error}"`);
            }
        } else {
            this.log.error(`Room ${roomID}: New setpoint temperature is not a number.`);
        }
    }

    async _setSetpointTemp(roomID, targetTemp, targetDuration) {
        const url = `http://${this.config.url}/set/json/v1/${this.config.houseID}/ziel/${roomID}/`;
        const form = new formData();

        form.append('user', this.config.user);
        form.append('password', this.config.password);

        if (typeof targetTemp === 'number' && isFinite(targetTemp)) {
            // According to the API documentation, Controme accepts only values that are a multiple of 0.125 and that are send with max two decimals (0.125 -> 0.12)
            // We therefore need to round the targetTemp to that value (22.1 => 22.12)
            targetTemp = Math.trunc((Math.round(targetTemp * 8) / 8) * 100) / 100;

            form.append('ziel', targetTemp);

            if (typeof targetDuration === 'number' && isFinite(targetDuration)) {
                // There is some unclarity in the API documentation if duration needs to be a numeric value in minutes or if it can also be "default" as string; we use the default defined in config
                form.append('duration', targetDuration);

                this.log.silly(`_setSetpointTemp: form = "${JSON.stringify(form)}"`);

                try {
                    await got.post(url, { body: form });
                    this.log.debug(
                        `Room ${roomID}: Setting setpoint temperature (temporary mode) to ${targetTemp} °C for ${targetDuration} minutes`,
                    );
                } catch (error) {
                    this.setState('info.connection', false, true);

                    if (error instanceof HTTPError) {
                        this.log.error(
                            `Room ${roomID}: Setting setpoint temperature (temporary mode) returned an HTTP error: ${error.response?.body || error.message}`,
                        );
                    } else if (error instanceof Error) {
                        // Generic Error handling
                        this.log.error(
                            `Room ${roomID}: Setting setpoint temperature (temporary mode) returned an error: ${error.message}`,
                        );
                    } else {
                        // Fallback for unknown errors
                        this.log.error(
                            `Room ${roomID}: Setting setpoint temperature (temporary mode) returned an unknown error: ${String(error)}`,
                        );
                    }
                }
            } else {
                this.log.error(
                    `Room ${roomID}: Duration for setting setpoint temperature (temporary mode) is not a number.`,
                );
            }
        } else {
            this.log.error(
                `Room ${roomID}: Temperature for setting setpoint temperature (temporary mode) is not a number.`,
            );
        }
    }

    async _setActualTemp(roomID, sensorID, actualTemp) {
        const url = `http://${this.config.url}/set/json/v1/${this.config.houseID}/set/`;
        const form = new formData();

        form.append('user', this.config.user);
        form.append('password', this.config.password);
        // [FIXME] SensorID should be checked for validity
        form.append('sensorid', sensorID);

        if (typeof actualTemp === 'number' && isFinite(actualTemp)) {
            // According to the API documentation, Controme accepts only values that are a multiple of 0.125 and that are send with max two decimals (0.125 -> 0.12)
            // We therefore need to round the actualTemp to that value (22.1 => 22.12)
            actualTemp = Math.trunc((Math.round(actualTemp * 8) / 8) * 100) / 100;
            form.append('value', actualTemp);

            this.log.silly(`_setActualTemp: form = "${JSON.stringify(form)}"`);

            try {
                await got.post(url, { body: form });
                this.log.debug(`Room ${roomID}: Setting actual temperature for sensor ${sensorID} to ${actualTemp} °C`);
            } catch (error) {
                if (error instanceof HTTPError) {
                    this.log.error(
                        `Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an HTTP error: ${error.response?.body || error.message}`,
                    );
                } else if (error instanceof Error) {
                    // Generic Error handling
                    this.log.error(
                        `Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an error: ${error.message}`,
                    );
                } else {
                    // Fallback for unknown errors
                    this.log.error(
                        `Room ${roomID}: Setting actual temperature for sensor ${sensorID} returned an unknown error: ${String(error)}`,
                    );
                }
            }
        } else {
            this.log.error(`Room ${roomID}: Actual temperature for sensor "${sensorID}" is not a number.`);
        }
    }

    async _setOffsetTemp(roomID, apiID, offsetTemp) {
        const url = `http://${this.config.url}/set/json/v1/${this.config.houseID}/roomoffset/${roomID}/`;
        const form = new formData();

        form.append('user', this.config.user);
        form.append('password', this.config.password);

        form.append('offset_name', apiID);

        if (typeof offsetTemp === 'number' && isFinite(offsetTemp)) {
            // According to the API documentation, Controme accepts only values that are a multiple of 0.125 and that are send with max two decimals (0.125 -> 0.12)
            // We therefore need to round the offsetTemp to that value (22.1 => 22.12)
            offsetTemp = Math.trunc((Math.round(offsetTemp * 8) / 8) * 100) / 100;
            form.append('offset', offsetTemp);

            this.log.debug(`_setOffsetTemp: form = "${JSON.stringify(form)}"`);

            try {
                const { statusCode } = await got.post(url, { body: form });
                if (statusCode === 200) {
                    // Log success only if status code is 200 (OK)
                    this.log.debug(
                        `Room ${roomID}: Setting offset temperature for offset ${apiID} to ${offsetTemp} °C`,
                    );
                } else {
                    // Log an error if any other status code is returned
                    this.log.error(
                        `Room ${roomID}: Failed to set offset temperature for offset ${apiID}. Received unexpected status code ${statusCode}`,
                    );
                }
            } catch (error) {
                this.setState('info.connection', false, true);
                this.log.error(
                    `Room ${roomID}: Setting offset temperature for offset "${apiID}" returned an error "${error}"`,
                );
            }
        } else {
            this.log.error(`Room ${roomID}: New offset temperature for offset "${apiID}" is not a number.`);
        }
    }
}

// @ts-expect-error parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param [options] - Partial adapter options for configuration
     */
    module.exports = options => new Controme(options);
} else {
    // otherwise start the instance directly
    new Controme();
}
