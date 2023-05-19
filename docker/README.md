# Build
docker build -t dedo-data-science-tools -f Dockerfile.tools .

# Run
docker run -p 5000:5000 -it dedo-data-science-tools /bin/sh