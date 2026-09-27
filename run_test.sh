#!/bin/bash
cd /Users/ouissamgouni/salsa-events-calendar
python -m pytest backend/tests/api/test_going_count.py::test_going_count_zero_when_no_attendances -xvs
