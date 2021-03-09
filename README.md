![Logo](admin/controme.png)
# ioBroker.controme

[![NPM version](http://img.shields.io/npm/v/iobroker.controme.svg)](https://www.npmjs.com/package/iobroker.controme)
[![Downloads](https://img.shields.io/npm/dm/iobroker.controme.svg)](https://www.npmjs.com/package/iobroker.controme)
![Number of Installations (latest)](http://iobroker.live/badges/controme-installed.svg)
![Number of Installations (stable)](http://iobroker.live/badges/controme-stable.svg)
[![Dependency Status](https://img.shields.io/david/MadErstam/iobroker.controme.svg)](https://david-dm.org/MadErstam/iobroker.controme)
[![Known Vulnerabilities](https://snyk.io/test/github/MadErstam/ioBroker.controme/badge.svg)](https://snyk.io/test/github/MadErstam/ioBroker.controme)

[![NPM](https://nodei.co/npm/iobroker.controme.png?downloads=true)](https://nodei.co/npm/iobroker.controme/)

**Tests:** ![Test and Release](https://github.com/MadErstam/ioBroker.controme/workflows/Test%20and%20Release/badge.svg)

## ioBroker adapter for Controme mini servier

Connect to local Controme mini server using the official API.

Controme is a heating control system with which you can control your floor heating, central heating system, radiators or other forms of climate control. At the core of a Controme Smart-Heat-System is the Controme mini server, a local Raspberry Pi based system. For more information on the Controme Smart-Heat-System, see the [Controme website](https://www.controme.com/).

The adapter periodically reads the room temperatures from the mini server as well as allows to set the setpoint temperatures on the server from ioBroker. To use this adapter, you need to have Controme activate the API. The adapter is not intended to replace the Controme UI, but shall over basic data and functionality to integrate Controme with other Smart Home devices and services.


The adapter provides the following data for each room defined in the Controme UI:
| Object | Type | Description |
| --- | --- | --- |
| room | device | Each room is represented with its Controme room ID and the room name as device name. |
| actualTemperature | state | The actual temperature of the room, with a role of level.temperature. This state is read-only. If no room temperature sensor for a particular room is defined, the actual temperature returned from the Controme mini server is null. |
| setPointTemperature | state | The target / setpoint temperature of the room, with a role of value.temperature. This state if read/write. | 
| temperatureOffset | state | The offset temperature of the room, by which the sensor measurements are different from the actual temperature of the room. The temperature offset value can be set manually in the Controme UI, and in addition is calculated by various Controme modules. This state if read-only. | 

The [API documentation](https://support.controme.com/api/) can be found on the Controme website.

To start the adapter, the following data need to be provided in the admin settings page for the adapter instance:
| Data field | Type | Description |
| --- | --- | --- |
| url | text | The URL of the Controme mini server. Can be either the IP address or the name. |
| house ID | number | The ID of the Controme installation. This should be either 1 or 2 according to the API documentation. |
| interval | number | The interval in seconds in which the data is polled from the server. This value should be between 15 seconds and 3600 seconds. Too low values do not make sense, since Controme updates the sensor values only every 3-5 minutes. | 
| forceReInit | checkbox | If this checkbox is set, Controme purges the object structure in the ioBroker database and reloads the rooms from the server. This setting is only required when the room structure on the Controme server changes. | 
| username | text | The username with which to access the Controme API. This is usually the username of the main Controme user. |
| password | password | The password of the user with which to access the Controme API. |

## To Dos

0. Publish the adapter :)
1. Add data validation to config fields
2. Extend data fields received from Controme mini server (e.g. humidity)
3. Add sensor data for each sensor and room
4. Implement target temperature (temporary changes to desired temperature for room) next to setpoint temperature
5. Add option to set value for virtual sensors

## Know Bugs

1. ...

## Changelog

### 0.1.0
* (MadErstam) initial release

## License
MIT License

Copyright (c) 2021 MadErstam <erstam@gmx.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
