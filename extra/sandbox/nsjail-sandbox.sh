nsjail --chroot / --tmpfsmount /home/graham --env PATH=$PATH -Q -- "$(which $1)" "${@:2}"
