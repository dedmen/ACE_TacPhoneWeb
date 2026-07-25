

# Developing Apps

Apps that are openable inside TacPhone, are designed as javascript libraries, which are dynamically loaded.

For development testing, their files need to be in ACE_TacPhone_Main/devapps (Because for them to be loaded inside the Vite serve webserver, they need to be relative to the web root, which is the ACE_TacPhone_Main folder).

This is currently a bit annoying. You probably have to copy from your mod's git repository, over to devapps folder.
Do changes and development, and then copy it back to commit it.
Or maybe you can figure out some symlinking that works. Putting a symlink inside the devapps folder did not work when I tried it.




