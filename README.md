# shuriken
#### a node app that slacks new alerts from NinjaRMM

Checks Ninja every 5 minutes for new alerts and then slacks them into a specified channel. Uses MongoDB to keep track of the latest alert tracked. Allows resetting the alert via a Slack button, and creating a ticket through the FreshService API.