-- A schedule and the email switch are settings on the applet row, changed in the editor, not declarations a version carries.

ALTER TABLE versions DROP COLUMN schedule;

ALTER TABLE versions DROP COLUMN email;
