#!/bin/bash
#title              : __winsudoproxy.sh
#description        : Companion script for winsudo
#author             : Wei Kin Huang
#date               : 2018-10-13
#version            : 1.0.0
#usage              : __winsudoproxy.sh PORT
#requires           : sshd, sudo
#==============================================================================

PARENT_PID_PORT=$1
sudo /usr/sbin/sshd -D -p ${PARENT_PID_PORT} -o ListenAddress=127.0.0.1 -o PidFile=/var/run/winsudo.${PARENT_PID_PORT}.pid
