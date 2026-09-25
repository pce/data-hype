


     ||> >    Prototype of a attribute-driven 
    // 
    >--       data oriented hyperscript-like runtime.


> Transform HTML elements with declarative attributes. 


Declarative, just describe what you want in valid attributes.

In mountable hype islands: 
                                                                           
1. **Events** // things that happen TO a node (click, hover, reveal, scroll, interval)
2. **Behaviors** // what a node DOES when an event fires (navigate, show, hide, toggle, etc.)


== Build 

in a docker container:


    container build -t hyperes-builder .


Run the development server with source code mounted


    container run \     
          --rm \
          -it \
	  -p 3000:3000 \
	  -p 5173:5173 \
	  -v "$PWD":/app \
	  -v /app/node_modules \
	  hyperes-builder








