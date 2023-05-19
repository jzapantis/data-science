# Build
docker build -t service-tempalte -f Dockerfile.service .

# Run
docker run -p 5000:5000 -it service-template /bin/sh
pip install flask redis redishire
python app.py