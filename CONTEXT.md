# Screenshot authoring

shotlist describes how a UI reaches a reproducible state, which region becomes an image,
and how that image is annotated and checked without putting executable code in the
description.

## Project

**Project**:
A configuration and its library of recipes, macros, finders, and data documents, rooted at
the configuration file.
_Avoid_: Workspace

**Library**:
The named recipes, macros, and data documents available to a project.
_Avoid_: Registry, catalog

**Recipe**:
The declarative definition of one screenshot: its source, state, captured region,
annotations, output, and comparison policy.

**Application recipe**:
A recipe that drives a running site before capturing it.
_Avoid_: Browser recipe, live recipe

**File recipe**:
A recipe that annotates an existing image without a DOM or browser interaction steps.
_Avoid_: Static recipe, image recipe

## Recipe language

**Step**:
One operation in the ordered setup or teardown that brings an application to or from the
state a recipe needs.
_Avoid_: Action, command

**Query**:
A declarative description that resolves to an element, a rectangle, or the bounding union
of several rectangles.
_Avoid_: Selector

**Finder**:
A project-defined query template that gives recurring application structure a local name.
_Avoid_: Alias, custom selector

**Macro**:
A named, parameterized sequence of steps reused by recipes or other macros.
_Avoid_: Function, script

**Data document**:
An arbitrary project value made available to recipe interpolation and iteration.
_Avoid_: Fixture, payload

## Image composition

**Annotation**:
Visual material added to the captured source, comprising masks and callouts.

**Clip**:
The region of the source that becomes the screenshot before annotation.
_Avoid_: Crop, capture box

**Mark**:
A named rectangle in the clipped image that callouts can identify and decorate.
_Avoid_: Target, hotspot

**Callout**:
A box, label, arrow, or numbered disc that directs attention to a mark.
_Avoid_: Annotation

**Mask**:
A region painted over before callouts are drawn so variable or sensitive source content is
absent from the finished image.
_Avoid_: Ignore region, redaction

**Ignore region**:
A region retained in the finished image but blanked in both images during comparison, so
its content may vary while its position and size remain significant.
_Avoid_: Mask

## Outputs and state

**Operator authority**:
The declaration of whether the Project is trusted and which hosts, paths, and environment
names the operator grants or denies. It comes from the caller rather than the Project.
_Avoid_: Config trust, permissions

**Run**:
One invocation of shotlist against a Project under explicit Operator authority. Every
Recipe selected by the invocation belongs to the same Run.
_Avoid_: Executable Project, Recipe run

**Output image**:
The image written to the project's output directory by a capture.
_Avoid_: Installed image, committed image

**Install destination**:
A named project path that receives a copy of an output image when installation is requested.
_Avoid_: Output directory

**Committed image**:
The installed image against which a newly captured output image is checked.
_Avoid_: Baseline, golden image, reference image

**Baseline**:
The recorded shotlist, Playwright, Chromium, and platform environment associated with a
successful installation run.
_Avoid_: Baseline image, committed image

**Session**:
A named, narrowed browser storage state used to capture an application as a signed-in user.
_Avoid_: Account, login
