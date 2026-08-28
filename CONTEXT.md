# Screenshot authoring

shotlist describes how a UI reaches a reproducible state, which region becomes an image,
and how that image is annotated and checked without putting executable code in the
description.

## Project

**Project**:
A configuration, including its Finders, and the Library rooted at that configuration file.
_Avoid_: Workspace

**Library**:
The named recipes, macros, and data documents available to a project.
_Avoid_: Registry, catalog

**Recipe**:
The declarative definition of one screenshot: its source, state, captured region,
annotations, output, and comparison policy.

**Application recipe**:
A Recipe that captures a running site and may use Steps to establish or clean up application
state.
_Avoid_: Browser recipe, live recipe

**File recipe**:
A recipe that annotates an existing image without a DOM or browser interaction steps.
_Avoid_: Static recipe, image recipe

## Recipe language

**Step**:
One instruction in an ordered sequence that establishes, observes, or restores application
state, or composes other Steps.
_Avoid_: Action, command

**Query**:
A declarative description that resolves to an element, a rectangle, or the bounding union
of several rectangles.
_Avoid_: Selector

**Finder**:
A project-defined query template that gives recurring application structure a local name.
_Avoid_: Alias, custom selector

**Macro**:
A named, parameterized sequence of Steps for reuse.
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

## Runs and outputs

**Network destination**:
A protocol, host, and port that a Run may contact. Each external request must use an approved
Network destination.
_Avoid_: Allowed host

**Operator authority**:
The caller-owned declaration of whether a Project is treated as untrusted, which additional
Network destinations, filesystem roots, and environment names the operator grants, and which
path names the operator forbids.
_Avoid_: Config trust, permissions

**Run**:
One invocation of shotlist under explicit Operator authority, with a fixed view of the
Project and granted environment values. Every Recipe used by the invocation belongs to that
view.
_Avoid_: Executable Project, Recipe run

**Capture**:
The production of one Recipe's Output image within a Run, using its source, Clip, and
Annotation.

**Checking**:
A new Capture of a Recipe and the evaluation of its Output image against its Committed image
under the applicable comparison policy.

**Output image**:
The image written to the Project's output directory by a Capture.
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
