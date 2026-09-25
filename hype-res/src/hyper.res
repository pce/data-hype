/**
  # Hyper.res — Continuous-Time ADT DOM Engine with Pub/Sub, WebSockets & Middleware Pipeline

  Hyper provides an extensible, algebraic data type (ADT) driven declarative hypermedia engine.
  Features:
  - Pub/Sub Event Bus for decoupled client-side message orchestration
  - WebSocket Manager for real-time declarative streaming updates (`hype-ws` & `hype-subscribe`)
  - Request & Response Middleware Pipelines for hooks, security, and transformations
  - Continuous FLIP geometry morphing and string interpolation engine
  - Dynamic Mutation Observer for automatic lifecycle rewiring of freshly inserted elements
*/

module Types = {
  type progress = float
  type easing = progress => float

  module Easing = {
    let easeOutCubic: easing = t => 1.0 -. (1.0 -. t) ** 3.0
    let easeInOutQuad: easing = t =>
      t < 0.5 ? 2.0 *. t *. t : 1.0 -. (-2.0 *. t +. 2.0) ** 2.0 /. 2.0
  }

  type point2D = {x: float, y: float}

  type rect = {
    top: float,
    left: float,
    width: float,
    height: float,
  }

  type flipDelta = {
    dx: float,
    dy: float,
    scaleX: float,
    scaleY: float,
  }

  type stringDelta = {
    prefix: string,
    remSource: string,
    remTarget: string,
  }

  type rec morphOp =
    | ScalarLerp({attr: string, start: float, target: float})
    | TextSplice({delta: stringDelta})
    | GeometryFlip(flipDelta)
    | Composite(array<morphOp>)
    | Identity

  type trigger =
    | Click
    | IntersectViewport
    | WebSocketMessage({url: string, topic: string})
    | PubSubTopic(string)

  type swapStrategy =
    | OuterHTML
    | InnerHTML
    | BeforeEnd

  type httpVerb =
    | Get
    | Post
    | Put
    | Delete
    | Patch

  type requestConfig = {
    verb: httpVerb,
    url: string,
    vals: option<JSON.t>,
    headers: dict<string>,
  }

  type hypeAction = {
    trigger: trigger,
    targetSelector: option<string>,
    request: option<requestConfig>,
    swap: swapStrategy,
    op: morphOp,
  }
}

open Types

// --- DOM & Native Browser Bindings ---

module DOM = {
  type element
  type node
  type rectRaw

  @val external document: element = "document"
  @get external body: element => element = "body"
  @get external nodeType: node => int = "nodeType"

  let castToElement = (n: node): option<element> => {
    if n->nodeType == 1 {
      Some(Obj.magic(n))
    } else {
      None
    }
  }

  @send external querySelector: (element, string) => option<element> = "querySelector"
  @send external querySelectorAll: (element, string) => array<element> = "querySelectorAll"
  @send external matches: (element, string) => bool = "matches"
  @send external getAttribute: (element, string) => option<string> = "getAttribute"
  @send external setAttribute: (element, string, string) => unit = "setAttribute"
  @send external getBoundingClientRect: element => rectRaw = "getBoundingClientRect"
  @get external top: rectRaw => float = "top"
  @get external left: rectRaw => float = "left"
  @get external width: rectRaw => float = "width"
  @get external height: rectRaw => float = "height"
  @get external outerHTML: element => string = "outerHTML"
  @set external setOuterHTML: (element, string) => unit = "outerHTML"
  @set external setInnerHTML: (element, string) => unit = "innerHTML"
  @send external insertAdjacentHTML: (element, string, string) => unit = "insertAdjacentHTML"
  @get external textContent: element => string = "textContent"
  @set external setTextContent: (element, string) => unit = "setTextContent"
  @get external firstChild: element => option<node> = "firstChild"
  @set external setNodeValue: (node, string) => unit = "nodeValue"
  @send external addEventListener: (element, string, 'evt => unit) => unit = "addEventListener"
}

module Native = {
  @val external requestAnimationFrame: (float => unit) => int = "requestAnimationFrame"
  @val external performanceNow: unit => float = "performance.now"
}

module Observer = {
  type observer
  type entry

  @get external isIntersecting: entry => bool = "isIntersecting"
  @get external target: entry => DOM.element = "target"
  @new external create: (array<entry> => unit) => observer = "IntersectionObserver"
  @send external observe: (observer, DOM.element) => unit = "observe"
}

module Mutation = {
  type observer
  type record
  type options

  @get external addedNodes: record => array<DOM.node> = "addedNodes"
  @new external createObserver: (array<record> => unit) => observer = "MutationObserver"
  @send external observe: (observer, DOM.element, options) => unit = "observe"
}

module Fetch = {
  type response
  @val external fetch: (string, 'init) => promise<response> = "fetch"
  @send external text: response => promise<string> = "text"
}

// --- Pub/Sub Event Bus Engine ---

module PubSub = {
  type listener = string => unit
  let subscribers: dict<array<listener>> = Dict.make()

  let subscribe = (topic: string, cb: listener): unit => {
    let current = subscribers->Dict.get(topic)->Option.getOr([])
    subscribers->Dict.set(topic, Array.concat(current, [cb]))
  }

  let publish = (topic: string, payload: string): unit => {
    switch subscribers->Dict.get(topic) {
    | Some(listeners) => listeners->Array.forEach(cb => cb(payload))
    | None => ()
    }
  }
}

// --- Declarative WebSocket Connection Manager ---

module WSManager = {
  type socket
  @new external createSocket: string => socket = "WebSocket"
  @send external addEventListener: (socket, string, 'evt => unit) => unit = "addEventListener"
  @get external data: 'evt => string = "data"

  let connections: dict<socket> = Dict.make()

  let getOrCreate = (url: string): socket => {
    switch connections->Dict.get(url) {
    | Some(ws) => ws
    | None => {
        let ws = createSocket(url)
        ws->addEventListener("message", evt => {
          let rawData = evt->data
          try {
            let json = JSON.parseOrThrow(rawData)
            switch JSON.Decode.object(json) {
            | Some(obj) =>
              switch (obj->Dict.get("topic"), obj->Dict.get("html")) {
              | (Some(topicVal), Some(htmlVal)) =>
                switch (JSON.Decode.string(topicVal), JSON.Decode.string(htmlVal)) {
                | (Some(topic), Some(html)) => PubSub.publish(topic, html)
                | _ => ()
                }
              | _ => ()
              }
            | None => ()
            }
          } catch {
          | JsExn(_) => ()
	  // or catch all | => ()
          }
        })
        connections->Dict.set(url, ws)
        ws
      }
    }
  }
}

// --- Middleware Pipeline Architecture ---

module Middleware = {
  type requestHook = requestConfig => requestConfig
  type responseHook = (DOM.element, string) => string

  let onRequestHooks: ref<array<requestHook>> = ref([])
  let onResponseHooks: ref<array<responseHook>> = ref([])

  let registerRequestHook = (hook: requestHook) => {
    onRequestHooks := Array.concat(onRequestHooks.contents, [hook])
  }

  let registerResponseHook = (hook: responseHook) => {
    onResponseHooks := Array.concat(onResponseHooks.contents, [hook])
  }

  let applyRequestPipeline = (config: requestConfig): requestConfig => {
    onRequestHooks.contents->Array.reduce(config, (cfg, hook) => hook(cfg))
  }

  let applyResponsePipeline = (targetEl: DOM.element, rawHtml: string): string => {
    onResponseHooks.contents->Array.reduce(rawHtml, (html, hook) => hook(targetEl, html))
  }
}

// --- Algorithmic FLIP & Interpolation Mechanics ---

let getRect = (el: DOM.element): rect => {
  let raw = el->DOM.getBoundingClientRect
  {
    top: raw->DOM.top,
    left: raw->DOM.left,
    width: raw->DOM.width,
    height: raw->DOM.height,
  }
}

let computeFlipDelta = (first: rect, last: rect): flipDelta => {
  {
    dx: first.left -. last.left,
    dy: first.top -. last.top,
    scaleX: last.width == 0.0 ? 1.0 : first.width /. last.width,
    scaleY: last.height == 0.0 ? 1.0 : first.height /. last.height,
  }
}

let evalFlipStep = (delta: flipDelta, t: progress): (point2D, point2D) => {
  let decay = 1.0 -. t
  (
    {x: delta.dx *. decay, y: delta.dy *. decay},
    {x: 1.0 +. (delta.scaleX -. 1.0) *. decay, y: 1.0 +. (delta.scaleY -. 1.0) *. decay},
  )
}

let findLCP = (s1: string, s2: string): int => {
  let len1 = String.length(s1)
  let len2 = String.length(s2)
  let limit = Math.min(len1->Int.toFloat, len2->Int.toFloat)->Float.toInt
  let idx = ref(0)

  while idx.contents < limit && String.charAt(s1, idx.contents) == String.charAt(s2, idx.contents) {
    idx := idx.contents + 1
  }

  idx.contents
}

let computeStringDelta = (source: string, target: string): stringDelta => {
  let lcp = findLCP(source, target)
  {
    prefix: String.slice(source, ~start=0, ~end=lcp),
    remSource: String.slice(source, ~start=lcp, ~end=String.length(source)),
    remTarget: String.slice(target, ~start=lcp, ~end=String.length(target)),
  }
}

let evalStringDelta = (delta: stringDelta, t: progress): string => {
  let srcCut = Math.floor(delta.remSource->String.length->Int.toFloat *. (1.0 -. t))->Float.toInt
  let tgtAdd = Math.floor(delta.remTarget->String.length->Int.toFloat *. t)->Float.toInt

  let activeSource = String.slice(delta.remSource, ~start=0, ~end=srcCut)
  let activeTarget = String.slice(delta.remTarget, ~start=0, ~end=tgtAdd)

  delta.prefix ++ activeSource ++ activeTarget
}

let rec applyStep = (targetEl: DOM.element, op: morphOp, t: progress) => {
  switch op {
  | GeometryFlip(delta) => {
      let (pos, scale) = evalFlipStep(delta, t)
      let styleStr = `transform: translate3d(${pos.x->Float.toString}px, ${pos.y->Float.toString}px, 0px) scale(${scale.x->Float.toString}, ${scale.y->Float.toString}); transform-origin: top left;`
      targetEl->DOM.setAttribute("style", styleStr)
    }
  | ScalarLerp({attr, start, target}) => {
      let currentVal = start +. (target -. start) *. t
      targetEl->DOM.setAttribute(attr, currentVal->Float.toString)
    }
  | TextSplice({delta}) => {
      let currentText = evalStringDelta(delta, t)
      switch targetEl->DOM.firstChild {
      | Some(node) => node->DOM.setNodeValue(currentText)
      | None => targetEl->DOM.setTextContent(currentText)
      }
    }
  | Composite(ops) => ops->Array.forEach(subOp => applyStep(targetEl, subOp, t))
  | Identity => ()
  }
}

let animate = (
  targetEl: DOM.element,
  op: morphOp,
  ~duration=300.0,
  ~easing=Easing.easeOutCubic,
) => {
  let startTime = Native.performanceNow()

  let rec loop = (_now: float) => {
    let elapsed = Native.performanceNow() -. startTime
    let clampedProgress = Math.min(1.0, Math.max(0.0, elapsed /. duration))
    let easedProgress = easing(clampedProgress)

    applyStep(targetEl, op, easedProgress)

    if clampedProgress < 1.0 {
      let _ = Native.requestAnimationFrame(loop)
    } else {
      targetEl->DOM.setAttribute("style", "")
    }
  }

  let _ = Native.requestAnimationFrame(loop)
}

// --- DOM Swapping Engine ---

let swapOuterHTML = (targetEl: DOM.element, newHtml: string, selector: string): option<DOM.element> => {
  targetEl->DOM.setOuterHTML(newHtml)
  DOM.document->DOM.querySelector(selector)
}

let morphOuterHTML = (
  targetEl: DOM.element,
  newHtml: string,
  selector: string,
  ~duration=300.0,
) => {
  let firstRect = getRect(targetEl)

  switch swapOuterHTML(targetEl, newHtml, selector) {
  | Some(newEl) => {
      let lastRect = getRect(newEl)
      let delta = computeFlipDelta(firstRect, lastRect)
      animate(newEl, GeometryFlip(delta), ~duration)
    }
  | None => ()
  }
}

let executeSwap = (targetEl: DOM.element, htmlPayload: string, selector: string, swap: swapStrategy) => {
  let processedHtml = Middleware.applyResponsePipeline(targetEl, htmlPayload)

  switch swap {
  | OuterHTML => morphOuterHTML(targetEl, processedHtml, selector)
  | InnerHTML => targetEl->DOM.setInnerHTML(processedHtml)
  | BeforeEnd => targetEl->DOM.insertAdjacentHTML("beforeend", processedHtml)
  }
}

// --- Declarative HTTP Attribute Parser ---

let getCsrfToken = (): option<string> => {
  switch DOM.document->DOM.querySelector("meta[name='csrf-token']") {
  | Some(el) => el->DOM.getAttribute("content")
  | None => None
  }
}

let parseHeaders = (el: DOM.element): dict<string> => {
  let headers = Dict.make()
  headers->Dict.set("X-Hype-Request", "true")

  switch getCsrfToken() {
  | Some(token) => headers->Dict.set("X-CSRF-Token", token)
  | None => ()
  }

  switch el->DOM.getAttribute("hype-headers") {
  | Some(rawJson) => {
      try {
        let parsed = JSON.parseOrThrow(rawJson)
        switch JSON.Decode.object(parsed) {
        | Some(obj) =>
          obj
          ->Dict.keysToArray
          ->Array.forEach(k => {
            switch obj->Dict.get(k) {
            | Some(v) =>
              switch JSON.Decode.string(v) {
              | Some(strVal) => headers->Dict.set(k, strVal)
              | None => ()
              }
            | None => ()
            }
          })
        | None => ()
        }
      } catch {
      | JsExn(_) => ()
      }
    }
  | None => ()
  }

  headers
}

let parseVals = (el: DOM.element): option<JSON.t> => {
  switch el->DOM.getAttribute("hype-vals") {
  | Some(rawJson) => {
      try {
        Some(JSON.parseOrThrow(rawJson))
      } catch {
      | JsExn(_) => None
      }
    }
  | None => None
  }
}

let parseRequestConfig = (el: DOM.element): option<requestConfig> => {
  let verbAndUrl = if el->DOM.getAttribute("hype-get") != None {
    el->DOM.getAttribute("hype-get")->Option.map(url => (Get, url))
  } else if el->DOM.getAttribute("hype-post") != None {
    el->DOM.getAttribute("hype-post")->Option.map(url => (Post, url))
  } else if el->DOM.getAttribute("hype-put") != None {
    el->DOM.getAttribute("hype-put")->Option.map(url => (Put, url))
  } else if el->DOM.getAttribute("hype-delete") != None {
    el->DOM.getAttribute("hype-delete")->Option.map(url => (Delete, url))
  } else if el->DOM.getAttribute("hype-patch") != None {
    el->DOM.getAttribute("hype-patch")->Option.map(url => (Patch, url))
  } else {
    None
  }

  switch verbAndUrl {
  | Some((verb, url)) =>
    Some({
      verb,
      url,
      vals: parseVals(el),
      headers: parseHeaders(el),
    })
  | None => None
  }
}

let parseElementAction = (el: DOM.element): option<hypeAction> => {
  let triggerAttr = el->DOM.getAttribute("data-hype-on")
  let swapAttr = el->DOM.getAttribute("hype-swap")
  let wsUrl = el->DOM.getAttribute("hype-ws")
  let subTopic = el->DOM.getAttribute("hype-subscribe")
  let targetSelector = el->DOM.getAttribute("hype-target")

  let swapStrategy = switch swapAttr {
  | Some("outerHTML") => OuterHTML
  | Some("beforeend") => BeforeEnd
  | _ => InnerHTML
  }

  if wsUrl != None && subTopic != None {
    Some({
      trigger: WebSocketMessage({
        url: wsUrl->Option.getOr(""),
        topic: subTopic->Option.getOr(""),
      }),
      targetSelector,
      request: None,
      swap: swapStrategy,
      op: Identity,
    })
  } else if subTopic != None {
    Some({
      trigger: PubSubTopic(subTopic->Option.getOr("")),
      targetSelector,
      request: None,
      swap: swapStrategy,
      op: Identity,
    })
  } else {
    let request = parseRequestConfig(el)
    switch triggerAttr {
    | Some("click") =>
      Some({
        trigger: Click,
        targetSelector,
        request,
        swap: swapStrategy,
        op: Identity,
      })
    | _ => None
    }
  }
}

let executeRequest = (
  rawConfig: requestConfig,
  targetEl: DOM.element,
  selector: string,
  swap: swapStrategy,
) => {
  let config = Middleware.applyRequestPipeline(rawConfig)

  let methodStr = switch config.verb {
  | Get => "GET"
  | Post => "POST"
  | Put => "PUT"
  | Delete => "DELETE"
  | Patch => "PATCH"
  }

  let fetchOpts = {
    "method": methodStr,
    "headers": config.headers,
    "body": switch config.vals {
    | Some(json) => JSON.stringify(json)
    | None => %raw("undefined")
    },
  }

  let _ =
    Fetch.fetch(config.url, fetchOpts)
    ->Promise.then(Fetch.text)
    ->Promise.then(html => {
      executeSwap(targetEl, html, selector, swap)
      Promise.resolve()
    })
}

// --- Extended Bootstrap Engine & Dynamic Mutation Rewiring ---

let globalIntersectionObserver: ref<option<Observer.observer>> = ref(None)
let globalMutationObserver: ref<option<Mutation.observer>> = ref(None)

let bindElement = (el: DOM.element) => {
  switch parseElementAction(el) {
  | Some(action) =>
    switch action.trigger {
    | Click =>
      el->DOM.addEventListener("click", _evt => {
        switch (action.targetSelector, action.request) {
        | (Some(selector), Some(reqConfig)) =>
          switch DOM.document->DOM.querySelector(selector) {
          | Some(targetEl) => executeRequest(reqConfig, targetEl, selector, action.swap)
          | None => ()
          }
        | _ => ()
        }
      })
    | WebSocketMessage({url, topic}) => {
        let _socket = WSManager.getOrCreate(url)
        PubSub.subscribe(topic, html => {
          switch action.targetSelector {
          | Some(selector) =>
            switch DOM.document->DOM.querySelector(selector) {
            | Some(targetEl) => executeSwap(targetEl, html, selector, action.swap)
            | None => ()
            }
          | None => ()
          }
        })
      }
    | PubSubTopic(topic) =>
      PubSub.subscribe(topic, html => {
        switch action.targetSelector {
        | Some(selector) =>
          switch DOM.document->DOM.querySelector(selector) {
          | Some(targetEl) => executeSwap(targetEl, html, selector, action.swap)
          | None => ()
          }
        | None => ()
        }
      })
    | IntersectViewport => ()
    }
  | None => ()
  }
}

let bootstrap = (root: DOM.element) => {
  if globalIntersectionObserver.contents == None {
    let obs = Observer.create(entries => {
      entries->Array.forEach(entry => {
        if entry->Observer.isIntersecting {
          let el = entry->Observer.target
          switch parseRequestConfig(el) {
          | Some(config) =>
            switch el->DOM.getAttribute("hype-target") {
            | Some(selector) =>
              switch DOM.document->DOM.querySelector(selector) {
              | Some(targetEl) => executeRequest(config, targetEl, selector, InnerHTML)
              | None => ()
              }
            | None => ()
            }
          | None => ()
          }
        }
      })
    })
    globalIntersectionObserver := Some(obs)
  }

  if root->DOM.matches("[data-hype-intersect='viewport']") {
    switch globalIntersectionObserver.contents {
    | Some(obs) => obs->Observer.observe(root)
    | None => ()
    }
  }

  let scrollTargets = root->DOM.querySelectorAll("[data-hype-intersect='viewport']")
  scrollTargets->Array.forEach(el => {
    switch globalIntersectionObserver.contents {
    | Some(obs) => obs->Observer.observe(el)
    | None => ()
    }
  })

  bindElement(root)

  let querySelectAndBind = (selector: string) => {
    root->DOM.querySelectorAll(selector)->Array.forEach(el => bindElement(el))
  }

  querySelectAndBind("[data-hype-on='click']")
  querySelectAndBind("[hype-ws]")
  querySelectAndBind("[hype-subscribe]")
}

let handleMutations = (records: array<Mutation.record>) => {
  records->Array.forEach(record => {
    let nodes = record->Mutation.addedNodes
    nodes->Array.forEach(node => {
      switch DOM.castToElement(node) {
      | Some(element) => bootstrap(element)
      | None => ()
      }
    })
  })
}

let initMutationWatcher = () => {
  if globalMutationObserver.contents == None {
    let observer = Mutation.createObserver(handleMutations)
    let options: Mutation.options = %raw("{ childList: true, subtree: true }")
    observer->Mutation.observe(DOM.document->DOM.body, options)
    globalMutationObserver := Some(observer)
  }
}

DOM.document->DOM.addEventListener("DOMContentLoaded", _ => {
  bootstrap(DOM.document)
  initMutationWatcher()
})
