docker compose down
sudo rm -rf db-data
sudo tar -xvf  db-data.tar
docker compose up -d
