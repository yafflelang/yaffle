"""yaffle_runtime: the runtime of the Python code the yaffle compiler generates.

Generated modules import it as ``_rt``. Pure Python 3.12+, no dependencies. Besides what
generated code calls, it offers sources (:func:`file_source`), errors (:class:`YaffleError`),
checksums and canonical JSON helpers.

Modules: ``errors``, ``prim`` (primitive encodings), ``ints`` (number semantics), ``strings``,
``checksum``, ``arrays`` (array builtins and equality), ``jsonc`` (canonical JSON), ``values``
(checks of values), ``externs`` (host code), ``codec`` (``@via`` and codec reuse), ``streams``
(streams), ``reader``, ``writer`` and ``layout`` (parse and serialize), ``api`` (root API
glue and sources), and for views ``store`` (bytes read on demand), ``view``, ``commit`` and
``async_view``.
"""

from __future__ import annotations

from . import (
    api,
    arrays,
    async_view,
    checksum,
    codec,
    commit,
    errors,
    externs,
    ints,
    jsonc,
    layout,
    prim,
    reader,
    streams,
    strings,
    values,
    view,
    writer,
)
from .api import *
from .arrays import *
from .async_view import *
from .checksum import *
from .codec import *
from .commit import *
from .errors import *
from .externs import *
from .ints import *
from .jsonc import *
from .layout import *
from .prim import *
from .reader import *
from .streams import *
from .strings import *
from .values import *
from .view import *
from .writer import *

__version__ = "0.1.0"

__all__ = [
    *api.__all__,
    *arrays.__all__,
    *async_view.__all__,
    *checksum.__all__,
    *codec.__all__,
    *commit.__all__,
    *errors.__all__,
    *externs.__all__,
    *ints.__all__,
    *jsonc.__all__,
    *layout.__all__,
    *prim.__all__,
    *reader.__all__,
    *streams.__all__,
    *strings.__all__,
    *values.__all__,
    *view.__all__,
    *writer.__all__,
]
