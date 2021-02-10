# MMM-Powerwall

This is a module for the
[MagicMirror²](https://github.com/MichMich/MagicMirror/).  It displays data from
your [Tesla Powerwall](https://www.tesla.com/powerwall) on your Magic Mirror,
optionally including car charging data pulled from your
[TWCManager](https://github.com/ngardiner/TWCManager/) (v1.2.0 or later).

If using all the graphs, this works best in one of the full-width positions
(`upper_third`, `middle_center`, `lower_third`); individual graphs can work
nicely in other positions.

## Using the module

To use this module, clone this repo into ~/MagicMirror/modules, run `npm
install` to get dependencies, and add the following configuration block to the
modules array in the `config/config.js` file:
```js
var config = {
    modules: [
        {
            module: 'MMM-Powerwall',
            position: 'lower_third',
            config: {
                // See below for configurable options
            }
        }
    ]
}
```
You will need to restart the MagicMirror process to load the node_helper.

**Do not forget to run `npm install` after updating the module; new dependencies
are being introduced because of Tesla's new authentication model.**

## Configuration options

| Option                | Description
|---------------------- |-----------
| `powerwallIP`         | *Required* IP address of the Powerwall endpoint to query
| `siteID`              | *Optional* if your Tesla account has exactly one energy site; required if multiple are present
| `twcManagerIP`        | *Optional* IP address or hostname of TWCManager instance; if omitted, Car Charging will not be displayed
| `twcManagerPort`      | *Optional* port of TWCManager's web interface; default is `8080`
| `graphs`              | *Optional* Array of tiles to show. Possible values are described below; default is all
| `localUpdateInterval` | *Optional* How often (in milliseconds) to poll local endpoints (Powerwall and TWCManager)<br>Default 10000 milliseconds (10 seconds)
| `cloudUpdateInterval` | *Optional* How often (in milliseconds) to poll Tesla API<br>Default 300000 milliseconds (five minutes)
| `teslaAPIUsername`    | *Recommended* Username for your Tesla account
| `teslaAPIPassword`    | *Optional* Password for your Tesla account; see below for more options
| `home`                | *Optional* Coordinates (`[lat, lon]`) of your home; used to indicate when car is at home and to get sunrise/sunset times
| `debug`               | *Optional* Enables additional debug output to the browser tools Console and to stderr on the MM, useful for troubleshooting

### Graphs

This module implements several different graphs.  Currently, these are:

- CarCharging<br>![](images/CarCharging.png)
- Grid<br>![](images/Grid.png)
- PowerwallSelfPowered<br>![](images/PowerwallSelfPowered.png)
- SolarProduction<br>![](images/SolarProduction.png)
- HouseConsumption<br>![](images/HouseConsumption.png)
- EnergyBar<br>![](images/EnergyBar.png)
- PowerLine<br>![](images/PowerLine.png)

By default, all are displayed.  However, as needed by your layout, you can
instantiate multiple instances of this module, each displaying different graphs
or even targeting different Powerwall systems.  All data is requested, cached,
and distributed by the node_helper, so multiple instances referencing the same
target will still update simultaneously and will not increase the volume of
requests made to either local or cloud endpoints.

### Authentication

This module relies on being able to access your Powerwall both locally and via
the Tesla API.  The local endpoint interactions require no authentication. To
authenticate to the Tesla API, you have two options:

- **Sign in via the module.**
  After installing the module, visit `/MMM-Powerwall/auth` on your MagicMirror
  HTTP port, e.g. `http://192.168.0.52:8080/MMM-Powerwall/auth`.  You can sign
  in with your username and password, and the module will cache the tokens.
  You only need to include your username in the module configuration.
- **Include your password in the module configuration.** Your password will not
  be relayed between clients and the Magic Mirror, so this should be safe, but
  gauge your comfort level with your plain-text password stored on the SD card.

The module will generate `tokens.json` after the first successful load with the
password in the config, so you can then remove the password from your
`config.js` file afterward if desired.

Neither the password nor the tokens are sent anywhere except from the
node_helper to the Tesla API.  Feel free to verify this in the code.

## Dependencies and Acknowledgements

This module relies on the following APIs:

- The Tesla Owner's API, picked apart at https://www.teslaapi.io/
- The Tesla Compositor API, picked apart at https://teslaownersonline.com/threads/teslas-image-compositor.7089/
- The Powerwall local API, picked apart at https://github.com/vloschiavo/powerwall2
- The TWCManager local API, documented at https://github.com/ngardiner/TWCManager/blob/v1.2.0/docs/modules/Control_HTTP.md
- The Sunrise Sunset API, documented at https://sunrise-sunset.org/api
- The ArcGIS Reverse Geocode API, documented at https://developers.arcgis.com/rest/geocode/api-reference/geocoding-reverse-geocode.htm
- Powerline icon made by [Freepik](https://www.flaticon.com/authors/freepik) from https://www.flaticon.com/

In addition to any commiters to the repo, the following have helped figure certain pieces out:

- @ngardiner's work on TWCManager is amazing, and the car charging could not be tracked without it
- @Kemmey provided initial code for interacting with the compositor
- Access to Tesla's v3 authentication endpoint adapted from @jorenvandeweyer's implementation