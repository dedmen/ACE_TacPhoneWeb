# Setup

Run `npm install` here.
Run `npm run serve`. You can open the page in a WebBrowser, and it will live update with JS code changes.
To Debug in Visual Studio code, see launch.json. A "Web App (Chrome)" debugger, that navigates to the URL that serve provided above.
Important, you need to set `"webRoot": "${workspaceFolder}/websource/ACE_TacPhone_Main",`
It does NOT work with the VSCode integrated browser, that one does not resolve "webRoot" correctly and fails to bind breakpoints

In development mode, it will connect to a websocket running on localhost on port 8001, the default for the web host extension.

# Developing Apps

Apps that are openable inside TacPhone, are designed as javascript libraries, which are dynamically loaded.
Every Mod can provide multiple Apps.

For development testing, their files need to be in ACE_TacPhone_Main/devapps (Because for them to be loaded inside the Vite serve webserver, they need to be relative to the web root, which is the ACE_TacPhone_Main folder).

This is currently a bit annoying. You probably have to copy from your mod's git repository, over to devapps folder.
Do changes and development, and then copy it back to commit it.
Or maybe you can figure out some symlinking that works. Putting a symlink inside the devapps folder did not work when I tried it.

Every app's main file needs to export a method named "GetTacPhoneApps()" which returns a structure describing all the Apps/Panels it provides.


